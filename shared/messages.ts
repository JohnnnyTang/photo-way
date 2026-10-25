import type { Locale } from "./locale";

/** Stable app-facing codes. Technical details remain separate in event.message. */
const en = {
    busy: "Another operation is still running.",
    cancelled: "Cancelled.",
    io: "A file could not be read or written.",
    unimplemented: "This feature is unavailable in this build.",
    unexpected: "An unexpected error occurred.",
    other: "The operation could not be completed.",
    noLocation: "No location data",
    unreadable: "Could not be read",
    unsupported: "Unsupported file type",
    duplicate: "Duplicates",
} as const;
const zhCN = {
    busy: "另一项操作仍在进行中。",
    cancelled: "已取消。",
    io: "无法读取或写入文件。",
    unimplemented: "此版本暂不支持该功能。",
    unexpected: "发生意外错误。",
    other: "无法完成操作。",
    noLocation: "没有位置信息",
    unreadable: "无法读取",
    unsupported: "不支持的文件类型",
    duplicate: "重复文件",
} satisfies Record<keyof typeof en, string>;

export const messages: Record<Locale, Record<keyof typeof en, string>> = { en, "zh-CN": zhCN };

export type MessageCode = keyof typeof en;
export function message(locale: Locale, code: MessageCode): string {
  return messages[locale][code];
}
