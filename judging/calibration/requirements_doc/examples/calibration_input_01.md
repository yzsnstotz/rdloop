# 用户通知服务需求文档 v1.0

**文档类型**：功能需求文档
**状态**：Draft

---

## 一、背景与目标

用户通知服务负责向用户发送站内信、邮件、Push 通知。当前系统缺乏统一的通知入口，各业务线重复开发。本次迭代目标：

- 提供统一通知 API，支持三种渠道（站内信/邮件/Push）
- 支持批量发送（每次最多 1000 个用户）
- 支持发送状态查询与失败重试

---

## 二、功能需求

### 2.1 发送通知（核心功能）

| 需求 ID | 描述 | 验收标准 |
|---------|------|----------|
| N1-1 | 发送单条通知 | POST /api/v1/notifications；参数：user_id, channel(in_app\|email\|push), title, body, metadata(可选)；返回 notification_id + status |
| N1-2 | 批量发送 | POST /api/v1/notifications/batch；user_ids 数组最多 1000；返回 batch_id + per-user 状态 |
| N1-3 | 渠道路由 | channel=in_app → 写入数据库；channel=email → 调用邮件服务；channel=push → 调用 FCM/APNs |
| N1-4 | 模板支持 | 支持 template_id + variables 方式发送；模板由内容团队维护，与代码解耦 |

### 2.2 状态查询

| 需求 ID | 描述 | 验收标准 |
|---------|------|----------|
| N2-1 | 单条查询 | GET /api/v1/notifications/:id；返回 status(pending\|sent\|failed\|delivered), sent_at, error_reason |
| N2-2 | 批量查询 | GET /api/v1/notifications/batch/:batch_id；返回各用户状态摘要 |
| N2-3 | 用户通知列表 | GET /api/v1/users/:user_id/notifications?channel=&limit=20&cursor=；支持分页 |

### 2.3 失败重试

| 需求 ID | 描述 | 验收标准 |
|---------|------|----------|
| N3-1 | 自动重试 | email/push 失败后自动重试最多 3 次，退避间隔 1/5/30 分钟 |
| N3-2 | 手动重试 | POST /api/v1/notifications/:id/retry；仅允许 status=failed 的记录触发 |
| N3-3 | 重试幂等 | 同一 notification_id 并发触发多次重试时，只有一次实际执行 |

---

## 三、非功能需求

| 类别 | 要求 |
|------|------|
| **性能** | 单条发送 API P99 ≤ 200ms；批量发送（1000 用户）P99 ≤ 2s |
| **可用性** | 服务 SLA ≥ 99.9%；邮件/push 渠道故障时站内信不受影响（渠道隔离） |
| **数据保留** | 通知记录保留 90 天；90 天后自动归档 |
| **安全** | API 需 Bearer token 鉴权；批量接口需额外权限 scope=notifications:batch |

---

## 四、约束与合规

- **GDPR 合规**：用户取消订阅后，72 小时内停止所有渠道通知；取消订阅状态须持久化
- **限流**：单用户每天最多收到 push 通知 50 条，邮件 10 封；超限时记录并丢弃，不报错
- **敏感数据**：notification body 禁止包含密码、完整银行卡号；服务启动时有静态检测规则
- **依赖服务**：邮件服务 SLA < 99%，需降级方案（队列积压，恢复后补发）

---

## 五、验收测试用例（摘要）

| 用例 ID | 前置条件 | 操作 | 预期结果 |
|---------|---------|------|---------|
| TC-01 | 用户存在，channel=in_app | POST /api/v1/notifications | 返回 200 + notification_id, status=pending |
| TC-02 | 邮件服务不可达 | POST /api/v1/notifications channel=email | 返回 200，异步队列写入，重试逻辑触发 |
| TC-03 | user_ids 超过 1000 条 | POST /api/v1/notifications/batch | 返回 400 + error_code=BATCH_SIZE_EXCEEDED |
| TC-04 | 用户已取消订阅 | POST /api/v1/notifications | 返回 200，status=suppressed，不实际发送 |
| TC-05 | 并发重试同一 notification_id | POST /retry × 5 并发 | 只有 1 次实际发送，其余返回 409 CONFLICT |

---

## 六、开放问题

1. Push 渠道是否需支持富文本（图片/按钮）？当前文档仅覆盖纯文本。
2. 模板版本管理策略未定义（模板更新是否影响已排队的通知？）。
