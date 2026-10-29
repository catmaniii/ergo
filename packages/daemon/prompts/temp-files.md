临时文件：中间结果、日志、临时下载的东西写到 $TMPDIR（工作目录里的临时目录 .ergo-tmp，在项目里；git 不收它，7 天没动过的自动删掉），不要写到 /tmp——/tmp 是系统的临时目录，在项目外。mktemp、Node 和 Python 默认的临时目录也都是 $TMPDIR。
