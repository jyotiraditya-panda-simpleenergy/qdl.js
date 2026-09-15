import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

/**
 * @template T
 * @param {T|T[]|undefined} value
 * @returns {T[]}
 */
function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * @typedef {object} ProgramEntry
 * @property {string} filename - Empty string means this entry is a no-op: a partition
 * intentionally left untouched by this release, not something to erase (see linux-msm/qdl's
 * firehose_program(), which returns immediately when filename is unset).
 * @property {string} label
 * @property {number} lun
 * @property {string} startSector - May be a literal integer or a "NUM_DISK_SECTORS±N" expression.
 * @property {number|undefined} numPartitionSectors
 * @property {boolean} sparse
 * @property {number} sectorSizeBytes
 */

/**
 * Parses the <program> entries of a rawprogram*.xml file.
 * @param {string} xmlText
 * @returns {ProgramEntry[]}
 */
export function parseRawProgramXml(xmlText) {
  const doc = xmlParser.parse(xmlText);
  const entries = asArray(doc?.data?.program);
  return entries.map((e) => ({
    filename: String(e.filename ?? "").trim(),
    label: String(e.label ?? ""),
    lun: Number(e.physical_partition_number ?? 0),
    startSector: String(e.start_sector ?? "0"),
    numPartitionSectors: e.num_partition_sectors !== undefined ? Number(e.num_partition_sectors) : undefined,
    sparse: String(e.sparse ?? "false").toLowerCase() === "true",
    sectorSizeBytes: Number(e.SECTOR_SIZE_IN_BYTES ?? 4096),
  }));
}

/**
 * @typedef {object} EraseEntry
 * @property {string} label
 * @property {number} lun
 * @property {string} startSector
 * @property {string} numSectors - May be a literal integer or a "NUM_DISK_SECTORS±N" expression.
 */

/**
 * Parses the <erase> entries of a rawprogram*.xml file. <erase> is a distinct tag from
 * <program> (see linux-msm/qdl's program.c): only these entries should actually be erased.
 * @param {string} xmlText
 * @returns {EraseEntry[]}
 */
export function parseEraseXml(xmlText) {
  const doc = xmlParser.parse(xmlText);
  const entries = asArray(doc?.data?.erase);
  return entries.map((e) => ({
    label: String(e.label ?? ""),
    lun: Number(e.physical_partition_number ?? 0),
    startSector: String(e.start_sector ?? "0"),
    numSectors: String(e.num_partition_sectors ?? "0"),
  }));
}

/**
 * @typedef {object} PatchEntry
 * @property {string} filename - patch*.xml lists every patch twice: once targeting a local GPT
 * image file (for tools that rebuild the GPT before upload) and once targeting "DISK" (the
 * already-flashed device). Callers writing directly to a connected device should only apply
 * entries where filename is "DISK" (or unset).
 * @property {number} lun
 * @property {string} startSector
 * @property {number} byteOffset
 * @property {number} sizeInBytes
 * @property {string} value - May be a literal integer, a "NUM_DISK_SECTORS±N" expression, or
 * "CRC32(<sectorExpr>,<lengthBytes>)" meaning: read that many bytes back from the device at the
 * given sector and use their CRC32 as the value.
 * @property {string} what
 * @property {number} sectorSizeBytes
 */

/**
 * Parses the <patch> entries of a patch*.xml file.
 * @param {string} xmlText
 * @returns {PatchEntry[]}
 */
export function parsePatchXml(xmlText) {
  const doc = xmlParser.parse(xmlText);
  const entries = asArray(doc?.patches?.patch);
  return entries.map((e) => ({
    filename: String(e.filename ?? "").trim(),
    lun: Number(e.physical_partition_number ?? 0),
    startSector: String(e.start_sector ?? "0"),
    byteOffset: Number(e.byte_offset ?? 0),
    sizeInBytes: Number(e.size_in_bytes ?? 0),
    value: String(e.value ?? "0"),
    what: String(e.what ?? ""),
    sectorSizeBytes: Number(e.SECTOR_SIZE_IN_BYTES ?? 4096),
  }));
}

/**
 * Finds which lun to mark bootable: the first <program> entry labeled "xbl", else "xbl_a", else
 * "sbl1" (checked in that order). Mirrors linux-msm/qdl's program_find_bootable_partition().
 * `multiple` is true when more than one of those three labels is present at all (not only when
 * they resolve to different luns, matching the reference tool) - the first one found still wins.
 * @param {ProgramEntry[]} programEntries
 * @returns {{ lun: number, multiple: boolean } | null}
 */
export function findBootablePartition(programEntries) {
  let lun;
  let multiple = false;
  for (const label of ["xbl", "xbl_a", "sbl1"]) {
    const entry = programEntries.find((e) => e.label === label);
    if (!entry) continue;
    if (lun === undefined) lun = entry.lun;
    else multiple = true;
  }
  return lun === undefined ? null : { lun, multiple };
}

/**
 * Resolves expressions like "33", "NUM_DISK_SECTORS-33." (trailing dot from QPST) to a sector
 * count. Only +/- of a single NUM_DISK_SECTORS substitution is supported, which covers every
 * rawprogram/patch file produced by Qualcomm tooling in practice.
 * @param {string} expr
 * @param {bigint} numDiskSectors
 * @returns {bigint}
 */
export function resolveSectorExpr(expr, numDiskSectors) {
  const cleaned = expr.trim().replace(/\.$/, "");
  if (/^-?\d+$/.test(cleaned)) return BigInt(cleaned);

  const substituted = cleaned.replaceAll("NUM_DISK_SECTORS", numDiskSectors.toString());
  const tokens = substituted.match(/[+-]?\s*\d+/g);
  if (!tokens || tokens.join("").replace(/[+-\s]/g, "") !== substituted.replace(/[+-\s]/g, "")) {
    throw new Error(`Unsupported sector expression: "${expr}"`);
  }
  return tokens.reduce((sum, tok) => sum + BigInt(tok.replace(/\s/g, "")), 0n);
}
