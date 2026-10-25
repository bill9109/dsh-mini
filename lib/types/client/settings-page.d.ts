/**
 * 设置 → DSH Mini. Laid out like the shell's own 模型 page so it reads as part of DSH: an H2 title
 * and intro per section, one row card per item (name, status dot, tags, then 编辑 / 删除 on the
 * right), an inline editor that opens inside the card, and a dashed "+ 添加…" button.
 *
 * The shell's styles are hashed CSS modules, so this file restates the same rules against the
 * same --dsw-* tokens instead of borrowing class names that change between builds.
 */
import { createElement as h } from 'react';
type Node = ReturnType<typeof h>;
export declare const SETTINGS_PAGE_CSS: string;
export declare function SettingsPage(): Node;
export {};
