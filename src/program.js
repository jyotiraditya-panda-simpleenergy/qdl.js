import { buf as crc32 } from "crc-32";
import * as Sparse from "./sparse";
import { findBootablePartition, parseEraseXml, parsePatchXml, parseRawProgramXml, resolveSectorExpr } from "./parser";

export * from "./parser";

const CRC32_CALL_RE = /^CRC32\(([^,]+),\s*(\d+)\)$/i;

/**
 * Resolves a <patch> `value`/`start_sector`: either a {@link resolveSectorExpr} expression, or
 * `CRC32(<sectorExpr>,<lengthBytes>)` - read that many bytes back from the device (reflecting
 * any earlier patches already applied this run) and compute their CRC32. Real Qualcomm patch
 * files use this to (re)stamp GPT header/partition-array checksums after correcting other fields.
 * @param {import("./qdl").qdlDevice} qdl
 * @param {number} lun
 * @param {string} value
 * @param {bigint} numDiskSectors
 * @param {number} deviceSectorSize
 * @returns {Promise<bigint>}
 */
async function resolvePatchValue(qdl, lun, value, numDiskSectors, deviceSectorSize) {
  const match = value.trim().match(CRC32_CALL_RE);
  if (!match) return resolveSectorExpr(value, numDiskSectors);

  const [, sectorExpr, lengthStr] = match;
  const sector = resolveSectorExpr(sectorExpr, numDiskSectors);
  const length = Number(lengthStr);
  const numSectors = Math.ceil(length / deviceSectorSize);
  const buffer = await qdl.firehose.cmdReadBuffer(lun, sector, numSectors);
  return BigInt(crc32(buffer.subarray(0, length)) >>> 0);
}

/**
 * @callback ProgramLog
 * @param {string} message
 * @param {"info"|"warn"|"error"} [level]
 * @returns {void}
 */

/**
 * Overall progress across the whole plan (erase + program + patch combined into one monotonic
 * scale), not per-entry - a callback reporting per-entry percentage resets to 0 at every file
 * boundary, which reads as the bar jumping backward.
 * @callback ProgramProgress
 * @param {number} stepsDone - Can be fractional while a large file is mid-transfer.
 * @param {number} stepsTotal
 * @returns {void}
 */

/**
 * Parses and runs a rawprogram*.xml + patch*.xml set: erases every <erase> entry, flashes every
 * <program> entry that has a filename (one with no filename is a real no-op in the reference
 * tool - it marks a partition intentionally left untouched, so it's skipped rather than erased),
 * then applies every <patch> entry whose filename is "DISK" (or unset) - patch*.xml lists each
 * patch twice, once for a local GPT image file and once for the live device, and only the
 * latter applies here. Mirrors what linux-msm/qdl's firehose_execute_ops does for
 * `qdl <programmer> rawprogram.xml patch.xml`.
 *
 * @param {import("./qdl").qdlDevice} qdl
 * @param {string[]} rawprogramXmlTexts - Contents of every rawprogram*.xml file to apply.
 * @param {string[]} patchXmlTexts - Contents of every patch*.xml file to apply.
 * @param {Map<string, Blob>} files - Partition images keyed by the `filename` referenced in
 * rawprogram*.xml.
 * @param {ProgramLog} log
 * @param {ProgramProgress} [onProgress]
 * @returns {Promise<void>}
 */
export async function runProgramPlan(qdl, rawprogramXmlTexts, patchXmlTexts, files, log, onProgress) {
  const eraseEntries = [];
  const programEntries = [];
  for (const xmlText of rawprogramXmlTexts) {
    eraseEntries.push(...parseEraseXml(xmlText));
    programEntries.push(...parseRawProgramXml(xmlText));
  }
  const patchEntries = [];
  for (const xmlText of patchXmlTexts) patchEntries.push(...parsePatchXml(xmlText));

  const numDiskSectorsByLun = new Map();
  const getNumDiskSectors = async (lun) => {
    let n = numDiskSectorsByLun.get(lun);
    if (n === undefined) {
      const gpt = await qdl.getGpt(lun, 1n);
      n = gpt.alternateLba + 1n;
      numDiskSectorsByLun.set(lun, n);
    }
    return n;
  };

  const deviceSectorSize = qdl.firehose.cfg.SECTOR_SIZE_IN_BYTES;

  const diskPatches = patchEntries.filter((p) => !p.filename || p.filename.toUpperCase() === "DISK");
  const stepsTotal = eraseEntries.length + programEntries.filter((e) => e.filename).length + diskPatches.length;
  let stepsDone = 0;
  const reportProgress = (fraction = 0) => onProgress?.(stepsDone + fraction, stepsTotal);

  for (const entry of eraseEntries) {
    const numDiskSectors = await getNumDiskSectors(entry.lun);
    const startSector = resolveSectorExpr(entry.startSector, numDiskSectors);
    const numSectors = resolveSectorExpr(entry.numSectors, numDiskSectors);
    if (numSectors > 0n) {
      const ok = await qdl.firehose.cmdErase(entry.lun, startSector, Number(numSectors));
      if (!ok) throw new Error(`failed to erase ${startSector}+0x${numSectors.toString(16)}`);
      log(`successfully erased ${startSector}+0x${numSectors.toString(16)}`);
    }
    stepsDone += 1;
    reportProgress();
  }

  for (const entry of programEntries) {
    if (!entry.filename) continue; // real no-op: partition intentionally left untouched

    const file = files.get(entry.filename);
    if (!file) {
      log(`unable to open ${entry.filename}...ignoring`, "warn");
      stepsDone += 1;
      reportProgress();
      continue;
    }

    const numDiskSectors = await getNumDiskSectors(entry.lun);
    const startSector = resolveSectorExpr(entry.startSector, numDiskSectors);

    const fileSectors = Math.ceil(file.size / deviceSectorSize);
    if (entry.numPartitionSectors !== undefined && fileSectors > entry.numPartitionSectors) {
      throw new Error(
        `"${entry.label}": image is ${fileSectors} sectors but partition only reserves ${entry.numPartitionSectors} sectors - aborting to avoid overwriting adjacent data`,
      );
    }

    const t0 = performance.now();
    const sparse = entry.sparse ? await Sparse.from(file) : null;
    if (!sparse) {
      const ok = await qdl.firehose.cmdProgram(entry.lun, startSector, file, (bytesDone) =>
        reportProgress(file.size > 0 ? bytesDone / file.size : 0),
      );
      if (!ok) throw new Error(`flashing of ${entry.label} failed`);
    } else {
      for await (const [offset, chunk] of sparse.read()) {
        if (!chunk) continue;
        if (offset % deviceSectorSize !== 0) throw new Error(`"${entry.label}": sparse chunk not sector-aligned`);
        const sector = startSector + BigInt(offset / deviceSectorSize);
        const ok = await qdl.firehose.cmdProgram(entry.lun, sector, chunk, (bytesDone) =>
          reportProgress(file.size > 0 ? (offset + bytesDone) / file.size : 0),
        );
        if (!ok) throw new Error(`flashing of ${entry.label} failed`);
      }
    }
    stepsDone += 1;
    reportProgress();

    const elapsedSeconds = Math.floor((performance.now() - t0) / 1000);
    if (elapsedSeconds > 0) {
      const kbPerSecond = Math.floor(file.size / elapsedSeconds / 1024);
      log(`flashed "${entry.label}" successfully at ${kbPerSecond}kB/s`);
    } else {
      log(`flashed "${entry.label}" successfully`);
    }
  }

  for (const patch of diskPatches) {
    const numDiskSectors = await getNumDiskSectors(patch.lun);
    const startSector = resolveSectorExpr(patch.startSector, numDiskSectors);
    const value = await resolvePatchValue(qdl, patch.lun, patch.value, numDiskSectors, deviceSectorSize);
    await qdl.firehose.cmdPatch(patch.lun, startSector, patch.byteOffset, patch.sizeInBytes, value.toString(), patch.what);
    stepsDone += 1;
    reportProgress();
  }
  if (diskPatches.length > 0) log(`${diskPatches.length} patches applied`);

  // Mirrors linux-msm/qdl's qdl_determine_bootable(): scan for xbl/xbl_a/sbl1 rather than
  // assuming a fixed lun. Silently does nothing if none of those labels were flashed (matches
  // the reference tool's ux_debug-level "no boot partition found", not shown by default).
  const bootable = findBootablePartition(programEntries);
  if (bootable) {
    if (bootable.multiple) {
      log(`Multiple candidates for primary bootloader found, using partition ${bootable.lun}`);
    }
    await qdl.firehose.cmdSetBootLunId(bootable.lun);
    log(`partition ${bootable.lun} is now bootable`);
  }
}

/** Keeps the first file seen per basename, recording any name that had more than one match. */
function dedupeByName(files) {
  const seen = new Map();
  const duplicates = [];
  for (const f of files) {
    if (seen.has(f.name)) duplicates.push(f.name);
    else seen.set(f.name, f);
  }
  return { unique: Array.from(seen.values()), duplicates };
}

/**
 * @typedef {object} FlashSet
 * @property {File|null} programmerFile
 * @property {File[]} rawprogramFiles
 * @property {File[]} patchFiles
 * @property {Map<string, File>} imageFiles
 * @property {string[]} duplicates - Filenames that matched more than once (e.g. a nested
 * duplicate copy of the whole release folder); the first match won for each.
 */

/**
 * Auto-detects a firehose programmer + rawprogram*.xml + patch*.xml + partition images from a
 * flat folder selection (a QFIL/QPST output directory), same layout `qdl --storage emmc
 * prog_firehose_ddr.elf rawprogram_unsparse0.xml patch0.xml` expects.
 * @param {File[]} files
 * @returns {FlashSet}
 */
export function detectFlashSet(files) {
  const isXml = (f) => f.name.toLowerCase().endsWith(".xml");
  const programmerFile =
    files.find((f) => /firehose/i.test(f.name) && /\.(elf|mbn|bin)$/i.test(f.name)) ?? null;
  const rawprogram = dedupeByName(files.filter((f) => isXml(f) && /rawprogram/i.test(f.name)));
  const patch = dedupeByName(files.filter((f) => isXml(f) && /patch/i.test(f.name)));
  const imageFiles = new Map(
    files.filter((f) => f !== programmerFile && !isXml(f)).map((f) => [f.name, f]),
  );
  return {
    programmerFile,
    rawprogramFiles: rawprogram.unique,
    patchFiles: patch.unique,
    imageFiles,
    duplicates: [...rawprogram.duplicates, ...patch.duplicates],
  };
}
