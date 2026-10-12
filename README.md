<p align="center">
  <img src="icon.svg" alt="dsh-plugin-debugging" width="80" height="80">
</p>

<h1 align="center">dsh-plugin-debugging</h1>

<div align="center">
  <p><em>Troubleshoot a running DSH instance: which change needs what to take effect, whether a plugin actually loaded, 401 vs connection-refused, and config dumps.</em></p>

  <p>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat&logo=deepseek&logoColor=white" alt="由 dsh 驱动"></a>
  </p>

  <p>
    <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml"><img src="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT 许可证"></a>
  </p>

  <p>
    各版本改动 → <a href="https://github.com/dsh-plugin-lab/dsh-plugin-debugging/releases">Releases</a>（与 npm 版本一一对应）
  </p>
</div>

---

> [!NOTE]
> 本仓由脚手架生成，**还只是一个骨架**：能装、能构建、能跑测试，但还没有做任何事。
> 从「它到底提供什么能力」开始写，把下面这些占位内容换成真的。

## 提供什么

TODO：一句话说清这个插件给使用者带来什么，然后逐条列能力。

## 安装

```shell
dsh plugin --profile <profile> add dsh-plugin-debugging
```

## 版本兼容

TODO：写清支持哪条宿主线，以及分水岭。**不要抄会漂的宿主版本号** ——
判据是 `package.json` 的 `engines.dsh`，要具体值就现查。

## 配置

TODO：有哪些配置项、写在哪、默认值是什么。

## 开发

```shell
npm ci
npm run typecheck
npm run build
npm run test
npm run check
```

## 许可证

[MIT](LICENSE)
