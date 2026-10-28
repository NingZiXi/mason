# Mason PCB2 explainer

28 秒，1920×1080，30fps；中文字幕与短英文标题，原创配乐及独立动作音效。用于官网的结构讲解动效，非录屏。

视频：`renders/mason-pcb2-explainer.mp4`。网站交付物：`../../docs/assets/mason-pcb2-*` 与 `../../docs/assets/examples/mason-pcb2-gerber.zip`。

## 重建

Node.js、Python（包含产品 CAD 依赖）、FFmpeg；依赖使用本目录 lockfile。

1. `npm ci`
2. `node prepare.mjs`（原始用户 ZIP 位于 Desktop；若已移走，可直接复用已提取的 public 数据和模型）
3. `python -X utf8 make-models.py`
4. `python -X utf8 configure.py`
5. `python -X utf8 score.py`
6. `npm run build`
7. `python -X utf8 C:/Users/Hszn/.agents/skills/guizang-product-video-skill/scripts/mix_audio.py plan.json`
8. `node render.mjs --audio assets/master.wav --output renders/mason-pcb2-explainer.mp4`

`npm run preview` 返回影片预览网址，空格播放，`await seek(18.6)` 定位帧；浏览器预览没有声音，MP4 包含音轨。

`DIRECTION.md` 保存分镜、机械约束和展示方案；`evidence/source.json` 保存原始文件哈希、实际解析器与板子统计；`evidence/component-imports.json` 保存展示构建依赖。

## 来源

- Gerber：用户提供的 PCB2 示例；网站示例仅重打包板框与两面锡膏层，不分发其余设计资料。
- CAD：直接运行本项目 `python/jig_generator.py`，原产品 MIT 许可。
- 配乐：`score.py` 原创确定性合成。
- 动作音效：归藏 product video 技能的原创素材，见 `assets/sfx/SOURCE.txt`。
- 字体：本机 Microsoft YaHei / Segoe UI，由系统渲染到视频，不再分发字体文件。
- 视频工具起步工程：归藏 product video 技能，原有 LICENSE / NOTICE.md 保留。
