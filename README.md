obsidian-annotator/
├── manifest.json          # 插件清单
├── package.json           # 构建配置
├── tsconfig.json          # TypeScript配置
├── esbuild.config.mjs     # 打包脚本
├── styles.css             # 样式文件
└── main.ts                # 主逻辑

---

### 第一步：
文件夹解压后放在/.obsidian/plugin里面

---

### 第二步：
在终端打开这个文件夹

---

### 第三步：
```
node -v
```
（以确保安装过node）

---

### 第四步：
```
npm install
npm run dev
npm run build
```
构建成功后会生成 main.js 文件。

---

### 第五步：
打开 Obsidian
进入 设置 → 第三方插件
关闭 安全模式（如果尚未关闭）
找到 MD Annotator 插件并 启用（没找到刷新一下）
