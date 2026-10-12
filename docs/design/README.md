# LUNA UI 设计交付

- [设计与 DeepSeek 实施文档](luna-ui-design-spec.md)
- [预览总览](preview-gallery.html)
- 可编辑源文件：`luna-explorer-ui.pen`，附属资源：`luna-explorer-ui-assets/`
- 稿件索引：`screen-manifest.json`

## 给 DeepSeek 的提示词

请读取 `/Users/dztyykxx/projects/moonhd/docs/design/luna-ui-design-spec.md`，查看同目录 Pen 稿和 `previews/` 中的 17 张预览，在现有月球程序上实现对应 UI 和地理交互。保留已满意的渲染、8K 底图及按需高清策略；实现自转轴、经纬网、坐标与地名探索，所有 UI 和辅助覆盖层都能独立隐藏，沉浸模式有可靠恢复入口。请实际修改代码并完成本地浏览器验证，不只输出方案，也不要自动发布 Sites。若没有 Pen MCP，直接按预览和文档实现，不要把 .pen 当普通 JSON 读取，更不能用截图代替实时界面。

## 每张预览

- [01 · 地貌探索 / 默认首页](previews/01-explore.png)
- [02 · 着陆点探索](previews/02-landing-sites.png)
- [03 · 搜索与坐标定位](previews/03-search-coordinates.png)
- [04 · 观察设置](previews/04-observation-settings.png)
- [05 · 自转轴开启](previews/05-rotation-axis.png)
- [06 · 经纬网开启](previews/06-coordinate-grid.png)
- [07 · 模拟月相](previews/07-simulated-phase.png)
- [08 · 自转控制](previews/08-auto-rotation.png)
- [09 · 图层与影像选项](previews/09-imagery-layers.png)
- [10 · 画质与高级数据](previews/10-quality-data.png)
- [11 · 面板可见性管理](previews/11-ui-visibility.png)
- [12 · 沉浸 / 全部隐藏](previews/12-immersive-clean.png)
- [13 · 沉浸 / 临时恢复入口](previews/13-immersive-restore.png)
- [14 · 月球概览](previews/14-moon-overview.png)
- [15 · 手机 / 月面探索](previews/15-mobile-explore.png)
- [16 · 手机 / 观察设置](previews/16-mobile-settings.png)
- [17 · 组件与异常状态规范](previews/17-components-states.png)

设计阶段已用 Pen MCP 检查布局并导出预览。本轮未更改 public/ 程序；数据接通、行为测试和产品性能验证由实施阶段完成。手机场景在稿中有意裁切，产品应按实际可用视口适配。
