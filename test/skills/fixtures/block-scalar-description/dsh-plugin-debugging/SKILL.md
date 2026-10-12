---
name: dsh-plugin-debugging
description: >-
  夹具：description 用了折叠标量（YAML block scalar）。本插件只解析单行标量，
  遇到块标量必须响亮失败，而不是把 `>-` 当成描述文本静默注册。
---

夹具：description 是块标量，必须判成 `bad-frontmatter`。
