请在仓库 `Orion-zhen/o-pi` 中重构 `find` 和 `grep` 的多来源候选融合与 Top-K 选择，使排序优先保证“模型最可能真正想找的目标”，同时保留适度的结果多样性。

## 目标

在不训练或引入深度学习模型的前提下，实现以下排序方案：

1. 保留现有离散语义 `tier`，不同 tier 不允许被连续分数越级。
2. 将当前 `familyCount → medianPercentile → bestPercentile` 的证据比较替换为 **family-aware weighted RRF**。
3. 将当前硬性的“每个文件/顶层目录先取一条”改为：

   * 前若干条严格保持 relevance 顺序；
   * 剩余名额通过轻量 MMR 做软多样性选择。
4. Repo Map 的 confidence、hop 和 freshness 必须影响结构证据强度。
5. 主结果与仅由图关系产生的 related context 保持清晰边界。
6. 保证确定性、无额外模型调用、无显著性能退化。

重点检查并修改：

* `src/file-tools/ranking-evidence.ts`
* `src/file-tools/ranking-selection.ts`
* `src/file-tools/find/fusion.ts`
* `src/file-tools/grep/fusion.ts`
* `src/file-tools/tools/find.ts`
* `src/file-tools/tools/grep.ts`
* `src/file-tools/repo-map-ranking.ts`
* `src/file-tools/find/renderer.ts`
* `src/file-tools/grep/packer.ts`
* 相关测试与 benchmark

## 一、保留语义 tier

继续把 `tier` 作为最高优先级排序条件。不要把所有信号压成单一分数。

排序顺序应保持：

```text
tier
→ 融合相关性
→ 必要的 hop/置信度条件
→ 稳定键
```

现有 tier 可基本沿用，仅在发现跨来源语义不一致时修正。必须保证：

* exact path、exact filename、exact qualified symbol 等明确命中稳定领先；
* BM25、fuzzy、hop 1/2 不得超过更强的直接命中；
* literal/regex 主结果必须经过实时正文验证；
* related 候选不能混入严格主结果。

## 二、实现 family-aware weighted RRF

将证据按独立 family 表示，例如：

```text
lexical:
  path
  literal / regex occurrence
  BM25

semantic:
  LSP workspace symbol

structural:
  AST definition/symbol
  Repo Map hop 0 direct evidence

graph:
  Repo Map hop 1/2 relationship propagation
```

同一 family 内多个来源高度相关，只保留该 family 的最佳贡献；不同 family 可以形成共识。

建议实现形式：

```text
sourceContribution =
  sourceWeight
  × confidence
  / (rrfK + sourceRank)

familyContribution =
  max(sourceContribution within family)

fusionScore =
  sum(familyContribution)
```

要求：

* 不跨来源比较 BM25、Fuse、Repo Map 原始 score。
* 来源 rank 使用通过 scope、glob、hash、live symbol 等验证后的顺序。
* `rrfK` 和权重集中定义为常量，便于 benchmark 调整。
* 默认参数保持保守，不要过度强化多来源共识。
* 单个来源第一名应有可能超过多个来源的低排名候选。
* 同一家族的 AST 与 Repo Map 重复确认不能双重累计。
* 无有效贡献的 family 不计入共识。

可根据现有数据结构选择直接保存 family RRF contribution，或扩展固定宽度 `RankingEvidence`。不要在热路径中使用动态复杂对象或频繁分配集合。

## 三、Repo Map 证据校准

Repo Map 不得因为是唯一候选就自动获得满强度 structural evidence。

至少考虑：

```text
candidate.confidence
candidate.hop
是否 direct evidence
freshness / hash verification
edge resolution
```

推荐边界：

* hop 0 且 confidence 足够高：进入 structural family；
* hop 0 但 confidence 偏低：允许召回，但降低贡献或不形成独立 family；
* hop 1/2：进入低权重 graph family，不继承 seed 的 exact symbol 地位；
* 无实时 hash 验证：不能进入主结果；
* 二跳只用于补充召回，不应形成强共识。

不要破坏当前 freshness gate、content hash 和 related file hash 验证。

## 四、修复来源内部排名输入

每个来源在计算 RRF rank 前必须有可信且确定的内部顺序。

### LSP

不要完全依赖语言服务器返回顺序。显式区分并排序：

```text
exact qualified symbol
exact symbol
prefix/token symbol match
fuzzy workspace symbol
reference
```

如果当前 LSP 数据结构无法区分 workspace symbol 与 reference，请增加明确字段，例如：

```ts
origin: "workspace-symbol" | "reference"
```

reference 不应与直接 symbol 定义处于相同 tier。

### Repo Map

保留 Repo Map 查询层返回顺序，但在实时验证后重新计算来源 rank。

对于没有明确 symbol/range 的文件级 Repo Map 候选，不要默认投影到 `units[0]`。优先：

1. candidate range；
2. candidate alias/evidence 对应的 unit；
3. 查询 token 最匹配的 unit；
4. entrypoint declared target；
5. 无法定位时返回文件级候选或放入 related。

不得把任意第一个函数伪装成查询目标。

## 五、实现 relevance head + MMR

移除当前无条件的两轮硬多样性策略，避免较差文件或目录挤掉高相关结果。

选择过程改为：

1. 先按完整相关性排序；
2. 前 `HEAD_SIZE` 条原样保留，建议默认 3；
3. 剩余名额使用 MMR 选择；
4. 最终输出时保持 relevance head 在最前；
5. MMR 选出的剩余候选可按其最终相关性恢复稳定顺序。

建议：

```text
mmrUtility =
  lambda × normalizedRelevance
  - (1 - lambda) × maxSimilarityToSelected
```

默认 `lambda` 建议在 `0.8～0.9` 之间。

无需 embedding。使用确定性代码结构相似度：

```text
同一 identity                    1.0
同一 symbol                     很高
同一文件且同一 role             高
同一文件                        中等
同一 component 且同一 role      较低
同一 component                  很低
不同文件和 component            0
```

具体数值自行设计，但必须：

* 只做软惩罚；
* 不能让低 tier 候选为了多样性挤掉高 tier 候选；
* limit 很小时尤其保护 top-1/top-3；
* 算法必须确定性；
* 时间复杂度应适合当前候选规模，避免全量高成本两两计算。

`find` 可使用 path、顶层目录、component、kind 计算相似度。

`grep` 可使用 path、symbol、candidate role、component、range identity 计算相似度。

## 六、修复 find renderer 的二次重排

检查 `src/file-tools/find/renderer.ts`。

当前宽结果中的 `Top matches` 可能再次按顶层目录覆盖重排，导致底层正确的 relevance 顺序被破坏。

修改为：

* renderer 不重新决定相关性；
* renderer 接收已经完成 relevance/MMR 选择的候选；
* `Top matches` 保留输入顺序；
* 路径树折叠只能影响未展开的其他结果，不能重排已选 top results。

## 七、主结果和 related 边界

维持并强化以下原则：

```text
主结果：
  有直接 path / symbol / textual 证据；
  或查询明确要求 caller/test/registration 等关系。

related：
  仅靠图关系得到；
  对原查询的直接匹配不保证。
```

可增加轻量 query intent 规则，用于识别：

```text
path
symbol
literal / regex
concept
caller / callee / reference
registration / entrypoint
test / mock / fixture
```

无需建立复杂分类器。只使用明显 token 和格式规则。

例如：

* 查询 `login`：定义进入主结果，caller/test 通常进入 related 或主结果后部；
* 查询 `callers of login`：caller 是主结果；
* 查询 `login tests`：test 候选可以进入主结果；
* 查询含扩展名或 `/`：更偏向 path intent；
* PascalCase、camelCase、qualified symbol：更偏向 symbol intent。

避免大规模改写查询系统，只在 tier、source weight 和 main/related 边界需要时使用 intent。

## 八、候选 identity

检查 `grep` 的跨来源 region identity。

当前如果 identity 过度依赖完全相同的 start line，Tree-sitter、LSP 和 Repo Map 对 decorator、annotation、doc comment 的范围差异可能导致同一 symbol 无法合并。

改进为稳定的等价判断或规范化 identity，例如：

```text
path
+ normalized qualified symbol
+ range overlap / 小范围起始行容差
```

需要避免错误合并 overload。可使用 signature、kind 和 range cluster 辅助区分。

无 symbol 的 fallback region 继续使用严格 range/id。

## 九、动态 cutoff

不要为了填满 `limit` 返回明显低质量候选。

加入保守 cutoff，例如根据以下条件保留：

* tier 在直接相关范围内；
* fusion score 相对同 tier 最佳候选不低于合理比例；
* 查询明确需要该 relationship/test 类型；
* 或候选被多个独立 family 高质量确认。

阈值应集中定义、可测试，并保证已有明确查询不会无故失去合理结果。

## 十、测试要求

新增或修改测试，至少覆盖：

### RRF 融合

* 单 family 第一名可以超过多个 family 的末位候选；
* 两个来源均高排名时形成有效共识；
* 同 family 重复证据不重复加分；
* confidence 会降低 Repo Map contribution；
* hop 1/2 不形成强 structural 共识；
* 输入顺序变化不影响最终结果。

### relevance head 和 MMR

* limit=1 时始终返回全局最相关候选；
* 前 3 名不会被文件/目录多样性打散；
* 多样性只影响剩余名额；
* 同文件大量重复结果会受到软惩罚；
* 较差 tier 不会因多样性超过更好 tier；
* `find` renderer 不再二次重排 top matches。

### LSP

* exact symbol 在 fuzzy symbol 前；
* workspace symbol 在 reference 前；
* LSP 返回顺序变化不会改变语义排序；
* 同一 AST/LSP symbol 能正确合并。

### Repo Map

* 低 confidence hop 0 不获得完整结构共识；
* hop 1/2 保持弱 graph evidence；
* 无 symbol 文件候选不会默认返回 `units[0]`；
* stale hash 候选被过滤；
* related 候选数量不会改变主结果 percentile/RRF rank。

### identity

* AST、LSP、Repo Map 对同一 symbol 范围相差一两行时仍可合并；
* overload 不会被错误合并。

### 回归

* exact path、exact filename、literal、regex、qualified symbol 行为保持；
* Repo Map 或 LSP 不可用时保持安全退化；
* 排序稳定；
* token budget、result limit、ignore、glob 和安全检查保持。

## 十一、benchmark 与文档

更新 `scripts/bench-file-tools-ranking.mjs`，除了验证选择算法与参考实现一致，还增加更接近实际 relevance 的固定场景，例如：

* 高相关同文件候选与低相关跨文件候选竞争；
* 多来源高排名共识；
* 多来源低排名伪共识；
* hop 0 与 hop 1/2 竞争；
* exact symbol、reference、test、registration 混合；
* renderer 前后顺序一致。

benchmark 不需要成为完整 relevance 数据集，但应能捕获本次修复针对的典型排序错误。

更新 `docs/file-tools-ranking.md`，说明：

* tier 与 RRF 的职责边界；
* evidence family；
* Repo Map confidence/hop；
* relevance head；
* MMR；
* main/related；
* cutoff；
* 确定性和复杂度。

## 十二、实现约束

* 不引入模型调用、embedding 服务或训练流程。
* 尽量不增加新的第三方依赖。
* 保持 TypeScript 类型清晰。
* 不破坏现有公开工具 schema。
* 不改变路径安全、ignore、glob、hash 和 freshness 语义。
* 以增量重构为主，不重写整个 `find`/`grep` 系统。
* 常量和策略集中管理，避免散落魔法数字。
* 保证 `npm test`、`npm run typecheck` 通过。
* 运行相关 benchmark，并报告前后结果。
* 如果现有设计与上述细节冲突，可自行选择更合理实现，但必须保持核心目标：top-K 精度优先，软多样性次之，确定性与可解释性保留。

完成后请总结：

1. 修改了哪些排序阶段；
2. RRF、confidence、MMR 的具体公式和默认参数；
3. main/related 边界如何变化；
4. 修复了哪些具体错误场景；
5. 新增了哪些测试和 benchmark；
6. 是否存在尚未解决的排序风险。
