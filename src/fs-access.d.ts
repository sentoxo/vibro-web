// Minimal File System Access API surface used by the export flow.

interface FileSystemWritableFileStreamQ extends WritableStream {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandleQ {
  readonly name: string;
  createWritable(): Promise<FileSystemWritableFileStreamQ>;
}

interface SaveFilePickerOptionsQ {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}

interface Window {
  showSaveFilePicker?(options?: SaveFilePickerOptionsQ): Promise<FileSystemFileHandleQ>;
}
