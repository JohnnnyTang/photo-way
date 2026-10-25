# Photo Way

[English](README.md) · [中文使用指南](docs/USER_GUIDE.zh-CN.md) · [English user guide](docs/USER_GUIDE.md)

把带有位置信息的照片和视频整理成可分享的旅行路线图。导出的单个 HTML 文件、文件夹或 ZIP 包可以在浏览器中打开；离线底图无需联网。

> **v0.1.0 已发布，界面目前以英语为主。** 简体中文界面正在为 **v0.2.0** 开发；请勿将开发中的功能视为当前版本已支持。进度见 [Wave 4 计划](docs/WAVE4_PLAN.md)。

## 功能

- 导入 iPhone 或 Android 手机拍摄的照片和视频，例如 HEIC、JPEG、MOV、MP4。
- 在地图和时间线上查看行程，按日期浏览，并过滤明显异常的 GPS 位置。
- 导出独立 HTML 文件，或包含媒体文件的文件夹和 ZIP 包。
- 导出的地图可直接从本地磁盘打开；联网时还可使用卫星、地形等在线底图。
- 支持 Windows 和 macOS。

## 开发

需要 Node.js 24、稳定版 Rust，以及对应平台的 C/C++ 工具链。构建步骤见 [BUILDING.md](docs/BUILDING.md)。

## 许可证

Photo Way 使用 MIT 许可证。HEIC 解码所用的 libheif/libde265 使用 LGPL-3.0；详情见 [构建文档](docs/BUILDING.md)。
