/**
 * i18n 入口:vue-i18n(composition 模式)
 * 语言由 ui store 管理,这里只创建实例并导出切换函数
 */
import { createI18n } from "vue-i18n";
import zh from "./zh";
import en from "./en";
import ja from "./ja";
import ko from "./ko";
import { getSystemLocale } from '../lib/locales';

export const i18n = createI18n({
  legacy: false,
  locale: getSystemLocale(),
  fallbackLocale: "en",
  messages: { zh, en, ja, ko },
});
