# Photo Way

[English](README.md) · [中文使用指南](docs/USER_GUIDE.zh-CN.md) · [English user guide](docs/USER_GUIDE.md)

把带有位置信息的照片和视频整理成可分享的旅行路线图。导出的单个 HTML 文件、文件夹或 ZIP 包可以在浏览器中打开；离线底图无需联网。

![示例行程的路线、照片图钉和时间线](docs/img/viewer-overview.png)

Photo Way 是适用于 Windows 和 macOS 的桌面应用，也提供 `photoway` 命令行工具。导入、预览和导出都在本机完成；应用不会上传你的文件。截图使用的是合成示例行程。

**v0.2.0 提供英语和简体中文界面。** 应用界面语言与导出地图语言可以分别选择。

## 下载

从[最新发布页](https://github.com/JohnnnyTang/photo-way/releases/latest)下载 Windows 安装程序（`.exe` 或 `.msi`）、macOS 通用版 `.dmg`，或仅含命令行工具的压缩包。发布页还提供 `SHA256SUMS.txt`、第三方许可证和相关源代码。安装包目前未签名，首次打开时系统可能出现安全提示；操作方法见[中文使用指南](docs/USER_GUIDE.zh-CN.md#安装)。

## 快速开始

打开应用，选择界面语言和导出语言，拖入照片文件夹，生成预览并选择导出格式。导出完成后可从应用中打开结果，也可以在导出的地图里切换语言。

命令行示例：

```sh
photoway inspect ~/Photos/trip
photoway build ~/Photos/trip -o trip.html
photoway build ~/Photos/trip -o trip.zip --format zip --full web
photoway serve trip.zip
```

## 功能

- 导入 iPhone 或 Android 手机拍摄的照片和视频，例如 HEIC、JPEG、MOV、MP4。
- 在地图和时间线上查看行程，按日期浏览，并过滤明显异常的 GPS 位置。
- 导出独立 HTML 文件，或包含媒体文件的文件夹和 ZIP 包。
- 导出的地图可直接从本地磁盘打开；联网时还可使用卫星、地形等在线底图。
- 可按日期查看距离、爬升、下降和用时；可以修正图钉位置、隐藏项目，并将编辑结果保存为副本。
- 导出时可移除 EXIF、降低坐标精度，或只包含缩略图。**路线图仍会显示拍摄地点**，分享前请检查敏感位置。
- 支持 Windows 和 macOS。

## 文档

- [中文使用指南](docs/USER_GUIDE.zh-CN.md)：安装、保留手机照片位置信息、使用应用和地图、隐私、命令行、故障排查。
- [英文使用指南](docs/USER_GUIDE.md)及[构建文档](docs/BUILDING.md)。
- [更新记录](CHANGELOG.md)、[项目架构](docs/ARCHITECTURE.md)与[数据格式](docs/DATA_CONTRACT.md)。

## 开发

需要 Node.js 24、稳定版 Rust，以及对应平台的 C/C++ 工具链。构建步骤见 [BUILDING.md](docs/BUILDING.md)。

## 许可证

Photo Way 使用 MIT 许可证。HEIC 解码所用的 libheif/libde265 使用 LGPL-3.0；详情见 [构建文档](docs/BUILDING.md)。
