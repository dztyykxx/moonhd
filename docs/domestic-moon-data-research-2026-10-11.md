# 国内月球影像方案调研

日期：2026-10-11。范围：为 moonhd 的在线细节寻找国内数据源；本次未修改程序或已发布站点。

## 结论

优先验证 China-VO 嫦娥二号 Lunar DOM 7M HiPS 的按需加载与本地缓存。已验证 HTTPS、无需凭据、跨域响应和最高层级实际 PNG。不能仅替换当前 WMS URL：必须适配 HEALPix NESTED 网格、瓦片选择与局部 UV/几何映射，核对经度方向。原始 DOM 具有拍摄时的光照，不能直接认定为可任意重新照明的光度归一化反射率。

## 已实测数据源

根目录：https://hips.china-vo.org/change2-moon-7m-dom/

元数据：https://hips.china-vo.org/change2-moon-7m-dom/properties

公开网页引用该源：https://nadc.china-vo.org/skyview/ ，其中 Lunar DOM 7M 配置指向上述地址，带 longitudeReversed 选项。

元数据字段：
- obs_title = Lunar DOM 7M
- hips_frame / hips_body = moon
- hips_order = 9，hips_order_min = 0
- hips_tile_width = 512
- hips_tile_format = png fits
- hips_pixel_bitpix / data_pixel_bitpix = 8
- hips_pixel_scale = 2.236E-4 度（按1737.4km半径折算约6.8m采样间隔，不等同于独立验证影像有效分辨率）
- s_pixel_scale = 2.871E-4 度
- moc_sky_fraction = 1（元数据声明全覆盖；本次仅抽样验证，未检查全月每个文件）
- hips_status = public master clonableOnce
- hips_estsize = 1454437179

HiPS 标准中 hips_estsize 单位为 KB，因此完整集合的发布者估算约1.45TB（按十进制）。这不是本次逐文件统计，也不能用来直接断言只下载PNG的总大小。clonableOnce 指可从主站复制，镜像不能继续提供可克隆链；不代表每个账号只能下载一次，也不代替原始数据的完整版权条款。

实际抽样（requests trust_env=False，不使用环境代理；不能排除系统级TUN/VPN）：
- properties：HTTP 200，3.18s
- Norder0/Dir0/Npix0.png：HTTP 200，218427字节，4.04s，512x512 RGBA，存在非空像素
- Norder9/Dir0/Npix0.png：HTTP 200，61557字节，0.49s，512x512 RGBA，存在非空像素
- 三项返回 Access-Control-Allow-Origin: *

详细响应记录和原始元数据保存在 domestic-moon-samples/。速度仅为本机小样本，不代表国内所有运营商或持续可用性。

## 其他国内入口

1. 国家天文台月球与行星数据发布系统：https://moon.bao.ac.cn/
   当前首页和 JS 可访问，存在科学数据/PDS卷集/注册登录入口。具体7m产品的下载权限与许可证未完成账号层面的验证。
2. 旧月图浏览：https://moon.bao.ac.cn/Moon/index/index.html
   HTML 与部分脚本可返回200，但脚本依赖的 /gis3globleMarsMoon/Build/TerraGlobe/MGIS.js 返回的是新版门户HTML而不是JavaScript。旧数据下载路径 /ce5web/searchOrder_dataSearchData.search 也返回新版门户HTML。因此不能因HTTP200宣称旧地图和下载功能正常，也不宜据此接入。
3. 万维望远镜国内入口：https://wwt.china-vo.org/ 已重定向至 https://nadc.china-vo.org/wwt/ 。提供Windows个人版下载；网页版本链接指向 worldwidetelescope.org，不能把它当作完全由国内托管的网页客户端。
4. 国内地质图/中文标记图可做知识图层，不等同于高分辨率月面DOM或法线/DEM。

## 建议实施路径

1. 做独立局部接入验证：选择有明确坐标的环形山，核对位置、清晰度、PNG亮度与阴影。
2. 现有8K底图作远景/失败回退，近景按需请求国内HiPS；瓦片加载完成前保留父层，避免闪烁。
3. 加入有限缓存、过期请求取消、请求合并和失败重试，降低源站请求量。未查到明确的公开QPS/日额度/SLA，不能解释为无限调用。
4. 自己离线浏览可以缓存看过的区域；全量镜像或对外再发布前核对数据署名和完整许可，不直接启动TB级下载。
5. 法线暂时沿用现有LOLA。DOM仅是影像，没有因7m影像而自动获得7m高程或法线。

## 官方参考

- 国内源的原始元数据：https://hips.china-vo.org/change2-moon-7m-dom/properties
- 官方发布说明：https://nadc.china-vo.org/article/20190507093053?locale=zh_CN
- 官方月球数据指南：https://nadc.china-vo.org/article/20220720160555
- HiPS当前工作草案（包含estsize单位和clonableOnce说明）：https://ivoa.net/Documents/HiPS/20260501/WD-HiPS-2.0-20260501.html
- 官方在线浏览源配置：https://nadc.china-vo.org/skyview/
