# 安卓 App

还没做。先用手机浏览器打开二狗的网页（`packages/web/`，由守护进程提供）。

做的时候照鸿蒙 App（`frontend/harmony/`）的路子：原生壳加载用户配好的二狗地址，不把网页打包进 App（`docs/adr/0022`）。

图标资源已经先放好了：`app/src/main/res/` 下的 `mipmap-*`（自适应图标两层、老式方形和圆形）和 `mipmap-anydpi-v26/` 的配置，以及 `ic_launcher-playstore.png`。由 `frontend/icon/generate.mjs` 生成，见 `frontend/icon/README.md`。
