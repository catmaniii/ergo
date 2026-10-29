// vitest 的 setupFiles（168 号票）：每个测试文件开始前装上自带的中文，守护进程里的模块直接调 t() 也查得到句子
// （起了守护进程的用例按它的语言设置换，停下时装回自带的中文）。
import { installBuiltinLocales } from "../src/i18n/index.ts";

installBuiltinLocales();
