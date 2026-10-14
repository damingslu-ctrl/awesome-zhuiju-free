# 验证与投诉记录

这里保存资源的历史记录，确保评分与下架决定可以被追溯。

## 文件

- `verifications.json`：每次人工或自动验证的结果，只追加、不覆盖历史。
- `availability.json`：GitHub Actions 每日生成的当前可访问性快照。
- `sources.json`：GitHub Actions 每日生成的 TVBox 配置可用采集接口快照。
- `notices.json`：权利通知、安全投诉和其他正式处理记录。
- `navigation-sync.json`：导航后台的同步规则、当前站点基线和增删改操作历史。

## 记录原则

- 不记录与处理无关的个人信息。
- 未核实的投诉状态使用 `received`，不要直接写成事实。
- 资源被降级、暂停或下架时，应写明原因和关联记录。
- 投诉撤回或处理完成后保留历史，但更新处理状态。
- 自动可访问性检测只表示 GitHub Actions 节点当时能否访问，不替代人工验证。
- `sources.json` 只覆盖 `tvbox_config` 分类：它记录「这条配置里抽出几个可直连的 Apple CMS 采集接口、其中几个探活能取到内容」。状态含义见下。
- `sources.json` 的条数不评价内容规模、画质与版权状况，也不代表同一网络环境下一定可用。
- 每次修改导航后台前，先核对 `README.md`、`navigation-sync.json` 的 `current_state` 和后台实际数据。
- 导航后台操作完成后，更新 `current_state`，并向 `operations` 追加记录；历史记录不覆盖。

投诉状态：

- `received`：已收到，等待复核
- `reviewing`：正在复核
- `actioned`：已采取措施
- `rejected`：材料不足或不适用
- `withdrawn`：提交方撤回

## 可用源状态

`sources.json` 里每条结果的 `status`：

- `usable`：配置可读，且至少一个采集接口探活能取到内容。
- `dead`：配置里确实有采集接口，但本次全部探活失败。
- `no_cms`：配置可读，但里面没有可直连的采集接口（例如全是需要 TVBox 引擎的 Spider 条目）。
- `unreadable`：配置取不到或不是 TVBox 配置，失败原因见 `error`。
- `unknown`：尚未检测，仅作为 README 渲染时的默认值出现。

结果里的 `cms_total` 是从配置中抽出的采集接口条数，`cms_unique` 是按「主机 + 路径」去重后的条数，
`passed` 是其中探活通过的条数。`failed_samples` 只保留少量失败样例，用于定位问题，不是完整清单。
