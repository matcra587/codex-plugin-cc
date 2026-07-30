import { isRecord } from "./validation.ts";

export interface JsonRpcError {
  code?: number;
  message?: string;
  [key: string]: unknown;
}

export interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!isRecord(value)) {
    return false;
  }

  if (value.id !== undefined && value.id !== null && typeof value.id !== "number" && typeof value.id !== "string") {
    return false;
  }
  if (value.method !== undefined && typeof value.method !== "string") {
    return false;
  }
  if (value.error !== undefined) {
    if (!isRecord(value.error)) {
      return false;
    }
    if (value.error.code !== undefined && typeof value.error.code !== "number") {
      return false;
    }
    if (value.error.message !== undefined && typeof value.error.message !== "string") {
      return false;
    }
  }

  return true;
}
