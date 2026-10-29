// 项目的服务（133 号票）的说法：校验不过的原因、上线不了的原因、交给维护者的通知、秘书工具的说明和结果。编排里不写文字，都从这里取。
// 174 号票：上线不了的原因、挂了的原因、确认时生效不了的原因给用户看（项目页、运营方案的结局），走 t()；
// 交方案时校验的问题、通知、秘书工具的说明和结果给模型看，照旧中文。
import { APP_BASE_PATH_ENV, forModel, type ProjectServiceView, serviceLine, serviceOpenLabel, t, tTable } from "@ergo/protocol";
import { PROPOSE_OPERATIONS_TOOL } from "../projects/api.ts";

/** 服务写得对不对（spec.ts） */
export const specText = {
  /** 交方案时（维护者看）、确认时生效不了（用户看）都会碰到 */
  needService: () => t("projectServices.spec.needService"),
  // @i18n-ignore-start model：交方案时校验的问题（交给维护者）
  noTrigger: "服务那一条不写 schedule、event（服务是常驻的：确认后上线，一直跑着）",
  noWorkflow: "服务那一条不能是流程（approach 不写或写 plain，不写 workflow）",
  noManual: "服务二狗现在能替你上线了：不写 manual",
  nameDash: (name: string) => `服务名「${name}」里不能有连着的两个连字符（LSM 的名字不许 "--"）`,
  commandOneLine: "启动命令只能是一行",
  // @i18n-ignore-end
  /** 交方案时（维护者看）、确认时生效不了（用户看）都会碰到 */
  cwdMissing: (dir: string) => t("projectServices.spec.cwdMissing", { dir }),
  // @i18n-ignore-start model：交方案时校验的问题（交给维护者）
  cwdOutside: (dir: string, workdir: string, records: string) => `工作目录 ${dir} 出界了：要在项目的工作目录（${workdir}）或项目档案（${records}）里面`,
  envDuplicate: (name: string) => `环境变量 ${name} 写了不止一次（不分大小写）`,
  envLsm: (name: string) => `环境变量 ${name}：LSM_ 开头的是 LSM 注入的接入身份，不能自己写`,
  envBasePath: `环境变量 ${APP_BASE_PATH_ENV} 由运行时注入（有网页的服务，值是 /apps/<应用名>），不用写`,
  envOneSource: (name: string) => `环境变量 ${name}：value（普通的值）、secret（密钥区里的文件名）、userEnv（用户环境变量）三样里写一样`,
  envSecretName: (name: string) =>
    `环境变量 ${name} 看名字是密钥，方案里不能写值：把密钥放进二狗数据目录的密钥区（secrets/）里的一个文件，这里写 secret: "<文件名>"（上线时由 LSM 从文件读出来注入），或者写 userEnv: true 取用户环境变量`,
  envSecretValue: (name: string) => `环境变量 ${name} 的值看着像密钥（一长串随机字母数字、sk-… 这类）：方案里不写密钥，改用 secret（密钥区里的文件名）或 userEnv`,
  envOneLine: (name: string) => `环境变量 ${name} 的值只能是一行`,
  envSecretFile: (name: string, file: string) => `环境变量 ${name} 的 secret「${file}」要是密钥区里的文件名（字母、数字、点、短横线、下划线，不带路径）`,
  // @i18n-ignore-end
  /** 交方案时（维护者看）、确认时生效不了（用户看）都会碰到 */
  portTaken: (port: number, holder: string) => t("projectServices.spec.portTaken", { port, holder }),
  // @i18n-ignore-start model：交方案时校验的问题（交给维护者）
  homeSpace: "网页的首页路径里不能有空格",
  planSameName: (service: string, first: string, second: string) => `「${first}」和「${second}」的服务名都是 ${service}：一个项目里的服务名不能重`,
  planSamePort: (port: number, first: string, second: string) => `「${first}」和「${second}」都用端口 ${port}：换一个`,
  // @i18n-ignore-end
};

/** 不能用的端口的说法 */
export const portHolderText = {
  daemonLocal: () => t("projectServices.port.daemonLocal"),
  daemonExternal: () => t("projectServices.port.daemonExternal"),
  service: (projectId: string, title: string) => t("projectServices.port.service", { projectId, title }),
};

// @i18n-ignore-start model：交给维护者的工具结果
/** 交方案时的前缀下自检 */
export const selfCheckText = {
  notRunning: (title: string, port: number) => `服务「${title}」现在没在跑（本机端口 ${port} 没有响应），没做前缀下自检：上线后运行时再查一遍，有问题会告诉你。`,
  passed: (title: string) => `服务「${title}」的首页前缀下自检过了（没有以 / 开头、不在前缀下的地址）。`,
  problems: (report: string) => `网页没守前缀约定（转发到 /apps/<应用名>/ 下面时这些地址会跑到二狗的根上去）：改成相对地址或用 ${APP_BASE_PATH_ENV} 拼，改好再交。\n${report}`,
};
// @i18n-ignore-end

/** 上线、撤下做不了的原因（项目页上给用户看） */
export const rolloutText = {
  notLinked: () => t("projectServices.rollout.notLinked"),
  unsupported: () => t("projectServices.rollout.unsupported"),
  withdrawNotLinked: (app: string) => t("projectServices.rollout.withdrawNotLinked", { app }),
  withdrawUnsupported: () => t("projectServices.rollout.withdrawUnsupported"),
  timeout: () => t("projectServices.rollout.timeout"),
};

// @i18n-ignore-start model：交给维护者的通知
/** 交给维护者的通知（唤起它） */
export const noticeText = {
  failed: (view: Pick<ProjectServiceView, "title" | "app" | "port">, reason: string) =>
    `运营方案里的服务「${view.title}」（${view.app}，端口 ${view.port}）没上线：${reason}。看看是什么原因（端口被占、命令写错、依赖没装、健康检查不过……），改好了用 ${PROPOSE_OPERATIONS_TOOL} 再交一份完整的运营方案（照旧的那几条也写上，这一条运行时会重新开起来），告诉用户。`,
  manual: (view: Pick<ProjectServiceView, "title" | "app">, reason: string) => `运营方案里的服务「${view.title}」（${view.app}）现在没法替用户上线：${reason}。项目页上标着"要你手动"，别跟用户说已经上线了。`,
  down: (view: Pick<ProjectServiceView, "title" | "app" | "port">, reason: string, autoRestart: boolean) =>
    `服务「${view.title}」（${view.app}，端口 ${view.port}）上线后挂了，现在不在线：${reason}。${autoRestart ? "它开着挂了自动重启，LSM 会按退避重拉几次；" : "它没开挂了自动重启，LSM 不会自己重拉；"}看看是什么原因（日志、依赖、端口、数据……），修好后用 ${PROPOSE_OPERATIONS_TOOL} 再交一份完整的运营方案（照旧的那几条也写上，这一条运行时会重新开起来，用户在卡上确认）。用户那边的入口、项目页上已经标着不在线，不用专门去告诉用户，要用户做什么时再说。好了运行时会再告诉你。`,
  /** 269：接上 LSM 时兜底去拉，没起来 */
  reviveFailed: (view: Pick<ProjectServiceView, "title" | "app" | "port">, reason: string) =>
    `服务「${view.title}」（${view.app}，端口 ${view.port}）本该在线（上线了、用户没关），二狗接上 LSM 时它没在跑，去拉起来没起来：${reason}。看看是什么原因（端口被占、依赖没起来、日志、数据……）；修好后请用户在项目卡片上点“启动”重新拉起，要改服务的定义就用 ${PROPOSE_OPERATIONS_TOOL} 再交一份完整的运营方案。项目页上标着上线失败，不用专门去告诉用户，要用户做什么时再说。`,
  recovered: (view: Pick<ProjectServiceView, "title" | "app">) => `服务「${view.title}」（${view.app}）又在线了：之前说的它挂了的事不用再处理（查到了原因的话记进项目档案）。`,
  prefix: (view: Pick<ProjectServiceView, "title" | "app">, report: string) =>
    `服务「${view.title}」（${view.app}）上线了，但首页的前缀下自检发现有地址不在前缀下（经二狗转发、在手机上打开时会坏）：\n${report}\n改成相对地址或用 ${APP_BASE_PATH_ENV} 拼，改好后重启服务（再交一份运营方案，或者让用户在 LSM 里重启）。`,
};

// @i18n-ignore-end

/** 257：LSM 那边做不了的原因 */
const POWER_LSM_TEXT = tTable({ disabled: "projectServices.power.lsm.disabled", waiting: "projectServices.power.lsm.waiting", unsupported: "projectServices.power.lsm.unsupported" });

/** 257：项目的服务全部启动、全部关闭做不了的原因（请求被拒时给用户看；秘书照样转述） */
export const powerText = {
  noProject: (projectId: string) => t("projectServices.power.noProject", { projectId }),
  notInUse: (name: string) => t("projectServices.power.notInUse", { name }),
  noServices: (name: string) => t("projectServices.power.noServices", { name }),
  lsm: (support: "disabled" | "waiting" | "unsupported") => POWER_LSM_TEXT[support],
  /** 关闭没做成、LSM 没给原因 */
  stopFailed: () => t("projectServices.power.stopFailed"),
};

/** 上线后挂了、LSM 没给原因时的说法（按换算后的状态；项目页上给用户看） */
export const outageReasonText: Partial<Record<ProjectServiceView["status"], string>> = tTable({
  failed: "projectServices.outage.failed",
  offline: "projectServices.outage.offline",
  missing: "projectServices.outage.missing",
  starting: "projectServices.outage.starting",
  stopping: "projectServices.outage.stopping",
});

// @i18n-ignore-start model：秘书工具的说明和结果、查看板时多列的一节
/** 秘书的"给出服务的入口" */
export const openServiceText = {
  description:
    "用户要打开、要找某个项目的服务的网页（“打开简报站”“简报站的页面在哪”）时用：按名字（服务的名字、项目的名字或编号）找到这个服务，把它的入口作为一张卡放进聊天——卡上写着在不在线，用户点“打开「X」”就在二狗的内置浏览器里打开（手机、外网也能开）。不要自己写网址让用户复制。",
  param: "服务的名字，或者它所在项目的名字、编号（用户怎么说就怎么写，比如“简报站”）",
  none: (query: string, all: readonly ProjectServiceView[]) =>
    forModel(() =>
      all.length > 0 ? `没找到和“${query}”对得上的服务。现在有的：\n${all.map((v) => `- ${serviceLine(v)}`).join("\n")}` : `没找到和“${query}”对得上的服务：现在没有项目上线了服务。`,
    ),
  given: (views: readonly ProjectServiceView[]) =>
    forModel(() => [
      ...views.map((v) => `- ${serviceLine(v)}`),
      views.some((v) => v.url !== undefined)
        ? `已把入口放进聊天：用户点卡上的“${serviceOpenLabel(views[0]!.title)}”就在内置浏览器里打开。不在线的点开会看到“现在没在运行”的说明。`
        : "这个服务没有网页，没有能打开的入口（卡上写着它在不在线）。",
    ].join("\n")),
};

/** 秘书的"启动、关闭项目的服务"（257） */
export const switchServicesText = {
  description:
    "用户要把某个项目的服务关掉或者开起来（“把简报站关了”“简报站先停一下”“把简报站开起来”）时用：和项目卡片、项目页上的“关闭”“启动”是同一个入口，经 LSM 把这个项目的服务全部关掉或者全部拉起。用户说了就是确认，不用再问。" +
    "关闭：全部停掉、取消开机自启，二狗或电脑重启后也不会起来，直到再启动；启动：全部拉起、恢复开机自启，等到就绪。" +
    "这不是停用项目（项目照旧使用中；停用、归档由用户在项目页上自己点），也不管公网通道之类的细节。",
  projectParam: "项目的名字或编号，或者它的服务的名字（用户怎么说就怎么写，比如“简报站”）",
  actionParam: "stop 全部关闭；start 全部启动",
  none: (query: string, all: readonly ProjectServiceView[]) =>
    forModel(() =>
      all.length > 0 ? `没找到和“${query}”对得上的项目的服务。现在有服务的：\n${all.map((v) => `- ${serviceLine(v)}`).join("\n")}` : `没找到和“${query}”对得上的：现在没有项目上线了服务。`,
    ),
  ambiguous: (query: string, names: readonly string[]) => `和“${query}”对得上的项目不止一个：${names.map((n) => `「${n}」`).join("、")}。问用户是哪一个，别自己挑。`,
  rejected: (name: string, action: "start" | "stop", reason: string) => `项目「${name}」的服务没法${action === "stop" ? "关闭" : "启动"}：${reason}。照实告诉用户，别说已经做了。`,
  result: (name: string, action: "start" | "stop", done: boolean, views: readonly ProjectServiceView[]) =>
    forModel(() =>
      [
        done
          ? action === "stop"
            ? `关好了：项目「${name}」的服务在 LSM 里全部停掉、取消了开机自启，二狗或电脑重启后也不会起来，直到再启动。现在：`
            : `做完了：项目「${name}」的服务交给 LSM 全部拉起、恢复了开机自启。现在（起不来的写着原因，照实告诉用户）：`
          : `已经交给 LSM ${action === "stop" ? "关闭" : "启动"}项目「${name}」的服务，还没做完（项目卡片上标着进度）。现在：`,
        ...views.map((v) => `- ${serviceLine(v)}`),
      ].join("\n"),
    ),
};

/** 秘书查看板时多列的一节 */
export const boardText = {
  title: "项目的服务（运营方案里上线到 LSM 的；用户要打开时用 open_service 把入口放进聊天）：",
};
// @i18n-ignore-end
