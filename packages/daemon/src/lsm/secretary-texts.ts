// 秘书指挥服务管家的工具（secretary-tools.ts）的说明和参数说明：给模型看，照旧中文。工具结果按当前语言写，在语言文件 lsm.tools.*。
// @i18n-ignore-file model：工具的说明、参数说明给秘书（模型）看

/** 每段说明末尾都带的一句：服务管家的事只用服务管家工具（419 的守卫拦 bash 的绕路写法时也这么叫它们） */
const NO_SHELL = "服务管家的事一律用服务管家工具（lsm_* 这几个）：不要用 bash 去跑 lsm、ergo svc、ergo stop/restart 这类命令，不要用 curl 去打服务管家的端口（默认 7420），也不要去杀进程。";

export const lsmToolDescriptions = {
  status:
    "看服务管家（LSM：这台电脑上托管常驻服务的那个程序，二狗自己、语音合成、项目的网页都由它起停）里有哪些服务、各自怎样：在不在跑、端口、开机自启、" +
    "忙不忙、最后一次出错，哪些标着「二狗离不开」（二狗自己、它的外网隧道、它离不开的，不能停、不能重启、不能撤）。不写 service 列出全部和场景；" +
    "写了只看那一个的详情（能不能优雅停机、依赖、公网和 tailnet 入口……）。用户问“语音服务还在跑吗”“服务管家里有什么”，或者要开关服务、拿不准叫什么名字时先用它。" +
    NO_SHELL,
  logs: "看服务管家里某个服务最后几行日志（默认是命令行输出；还有别的日志的，结果末尾写着，用 source 换）。服务起不来、挂了、用户问为什么时用。像密钥的已经擦掉；给用户讲要点，别整段贴。" + NO_SHELL,
  control:
    "开关服务管家里的服务，用户说了就做、不用再问：start 启动（等到就绪才回）；stop 停止（服务自己有停机办法的优雅停；没有的直接强制停下——杀进程，结果里会写明）；" +
    "stop_when_idle 等它空闲了再停（只对接入了忙闲的服务有用）；cancel_stop 取消等空闲再停；restart 立刻重启（没有重启办法的直接强制重启：先强制停再起，结果里会写明）；" +
    "autostart_on 加进开机自启；profile_start 按场景启动一组服务（写 profile，场景名用 lsm_status 看）。别的写 service。" +
    "项目上线的服务（二狗名下、ergo-daemon--p- 开头的）开关用 switch_project_services（和项目卡片上的按钮同一个入口，项目那边记得住），这里只在它管不到时用。" +
    "标着「二狗离不开」的不能停、不能重启（要重启二狗自己用 lsm_restart_self）。用户点名要强制停止、强制重启有正常办法的服务，以及移出开机自启、按场景停止、撤销、裁决孤儿，用 lsm_force，" +
    "公网入口和 tailnet 入口用 lsm_entries——那两个会出审批卡、用户点了才做。" +
    NO_SHELL,
  force:
    "要用户批准才做的服务管家操作：调用时出一张审批卡，用户点批准才真的做（对话审批关着也一样）。用户点名要做时才用，调之前用一句话说清会怎样。" +
    "force_stop 强制停止（杀进程，它手上正在做的会断；只在用户点名要强制停一个有正常停止办法的服务时用——没有正常办法的，lsm_control 的 stop 直接就会强制停）；force_restart 强制重启（先杀再起，同理）；" +
    "autostart_off 移出开机自启（现在跑着的照常跑，电脑重启后不再自己起来）；profile_stop 按场景停止一组服务（连它们依赖的一起强制停，写 profile）；" +
    "remove 撤销服务（强制停掉、从服务管家里拿掉登记；只有二狗名下的项目服务能撤，手写在服务管家里的请用户在它的网页上删）；" +
    "orphan_adopt 认领孤儿（服务的端口被一个服务管家不认识的进程占着时，认它就是这个服务）；orphan_kill 杀掉占着端口的那个进程。别的写 service。" +
    "标着「二狗离不开」的（二狗自己、它的外网隧道、它离不开的）做不了。" +
    NO_SHELL,
  entries:
    "要用户批准才做（出审批卡）：开关某个服务从外面连进来的入口。expose_on 打开公网入口（起它的公网隧道；服务管家里要已经配好隧道）；" +
    "expose_off 关掉公网入口（停它的隧道）；tailnet_open 给它开一个 tailnet 入口（只有用户自己的设备连得上；要连 VPS 签证书，可能要一两分钟；tailnetName 是域名的第一段，不写按服务名）；" +
    "tailnet_close 撤掉 tailnet 入口。二狗自己的外网入口关不了。开通公网（新建隧道）这里做不了，请用户在服务管家的网页上做。" +
    NO_SHELL,
  restartSelf:
    "重启二狗自己（守护进程）。只能“等空闲再重启”：手上的任务、正在执行的调用做完、你说完这一轮之后，服务管家让二狗退出再拉起来，这段对话接着在。" +
    "调用时出一张审批卡，用户批准后马上返回“已排队”，不会等重启完——拿到就跟用户说一声，别等、别反复查。用户要重启二狗（改了配置要生效、二狗卡住了）时用；" +
    "别为了别的事自己决定重启。不要用 bash 或别的工具重启、停止二狗。",
  serviceParam: "服务名：服务管家里的全名（lsm_status 列出来的），或者它的标题、名下服务的短名（用户怎么说就怎么写，比如“audiocpp”“语音合成”）",
  profileParam: "场景名（lsm_status 的“场景”那一行）",
  controlAction: "start 启动；stop 优雅停止；stop_when_idle 等空闲再停；cancel_stop 取消等空闲再停；restart 立刻重启；autostart_on 加进开机自启；profile_start 按场景启动",
  forceAction: "force_stop 强制停止；force_restart 强制重启；autostart_off 移出开机自启；profile_stop 按场景停止；remove 撤销；orphan_adopt 认领孤儿；orphan_kill 杀掉占着端口的进程",
  entriesAction: "expose_on 打开公网入口；expose_off 关掉公网入口；tailnet_open 开 tailnet 入口；tailnet_close 撤掉 tailnet 入口",
  tailnetNameParam: "tailnet 入口的名字（域名的第一段，小写字母、数字、连字符）；不写按服务名",
  linesParam: (def: number, max: number) => `看最后几行，默认 ${def}，最多 ${max}`,
  sourceParam: "第几份日志：0 是命令行输出（默认），别的看上一次结果末尾列的",
  reasonParam: "为什么重启（写在审批卡上给用户看），比如“改了配置要生效”",
};
