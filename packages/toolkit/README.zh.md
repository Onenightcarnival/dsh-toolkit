# @onenightcarnival/dsh-toolkit

[English](README.md) | **中文**

把 [dsh-toolkit](https://github.com/Onenightcarnival/dsh-toolkit) 的四个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件打进一个包：`dsh-rdb`（数据库）、`dsh-s3`（对象存储）、`dsh-otel`（OpenTelemetry 上报）、`dsh-bridge-browser`（浏览器桥）。面板、工具、设置、数据文件与 API 路径和单包完全一致；本包与单包二选一。

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-toolkit-<版本>.tgz
```

桌面版：「插件 → 配置中心… → 插件 → 从 .tgz 安装」。

## 模块

web profile 里是一行 `toolkit`，config 每个模块一个键，取值与该模块单包的配置相同；设为 `false` 即不挂载（主机与界面同时生效）。在 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖时整段 `config` 会被替换：

```yaml
- id: toolkit
  config:
    otel: false
    browser:
      discoveryPort: 43189
```

`GET /api/dsh-toolkit/modules` 返回实际挂载的集合，如 `{"rdb":true,"s3":true,"otel":false,"browser":true}`；client 半按它挂载界面。

## 结构

```
src/index.ts     host 半：把各模块作为子插件挂载，提供 /api/dsh-toolkit/modules
src/client.ts    client 半：按模块清单挂载各模块的 client 插件
src/typert.ts    otel 的 typert 清单以本包名重新生成
src/modules.ts   模块名与 API 路径，两个半边共用
build.mjs        直接从 ../rdb、../s3、../otel、../browser-bridge 的源码打包
```

MIT
