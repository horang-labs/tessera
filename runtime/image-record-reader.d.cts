export interface ImageRecordOptions { start?: number; end?: number; maxBytes?: number; maxMs?: number; signal?: AbortSignal }
export function readMetadataRecords(path: string, options: ImageRecordOptions,
  consume: (record: Record<string, any>, offset: number) => void | Promise<void>):
  Promise<{ offset: number; bytesRead: number; more: boolean }>;
