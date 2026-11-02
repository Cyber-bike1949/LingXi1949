# LingXi Core

LingXiCore 是单仓库中的内部共享包，供 `packages/obsidian-plugin` 与 `packages/remote` 共同使用。

共享 TypeScript 模块不得依赖 Obsidian 或任一产品；Rust `fs-operations` crate 由两个产品通过相对路径引用。Core 不作为用户单独安装的产品发布。
