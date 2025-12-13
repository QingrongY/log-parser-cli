# 日志解析评价指标数学公式

本文档提供baseline results中所有评价指标的数学表达式，适用于论文撰写。

生成时间: 2025-12-01
数据来源: `baseline/run_and_compare.py`

---

## 目录

1. [核心指标](#核心指标)
2. [纯度指标](#纯度指标)
3. [友好型指标](#友好型指标)
4. [符号说明](#符号说明)

---

## 符号说明

| 符号 | 含义 |
|------|------|
| $L = \{l_1, l_2, ..., l_n\}$ | 日志集合，包含 $n$ 条日志 |
| $G = \{g_1, g_2, ..., g_k\}$ | 真实标签（Ground Truth）集合 |
| $P = \{p_1, p_2, ..., p_m\}$ | 预测标签（Prediction）集合 |
| $G_i$ | 真实标签为 $g_i$ 的日志子集 |
| $P_j$ | 预测标签为 $p_j$ 的日志子集 |
| $\|S\|$ | 集合 $S$ 的基数（元素个数） |
| $\binom{n}{2}$ | 组合数，等于 $\frac{n(n-1)}{2}$ |

---

## 核心指标

### 1. Grouping Accuracy (GA)

GA 是基于成对比较的 F1 分数。

#### 1.1 准确配对数

$$
A = \sum_{j=1}^{m} \sum_{i=1}^{k} \binom{|P_j \cap G_i|}{2}
$$

其中：
- $P_j \cap G_i$ 表示预测为 $p_j$ 且真实标签为 $g_i$ 的日志集合
- 对每个预测cluster $P_j$，计算其内部同一真实标签的日志对数量

#### 1.2 预测总配对数

$$
T_P = \sum_{j=1}^{m} \binom{|P_j|}{2}
$$

#### 1.3 真实总配对数

$$
T_G = \sum_{i=1}^{k} \binom{|G_i|}{2}
$$

#### 1.4 精确率（Precision）

$$
\text{Precision} = \frac{A}{T_P}
$$

#### 1.5 召回率（Recall）

$$
\text{Recall} = \frac{A}{T_G}
$$

#### 1.6 F1分数（GA）

$$
\text{GA} = \frac{2 \times \text{Precision} \times \text{Recall}}{\text{Precision} + \text{Recall}}
$$

或等价于：

$$
\text{GA} = \frac{2A}{T_P + T_G}
$$

---

### 2. Parsing Accuracy (PA)

PA 衡量完美匹配的日志比例。

#### 2.1 完美匹配条件

预测cluster $P_j$ 完美匹配真实cluster $G_i$ 当且仅当：

$$
P_j = G_i
$$

即：
1. $P_j \subseteq G_i$（$P_j$ 中所有日志的真实标签都是 $g_i$）
2. $G_i \subseteq P_j$（真实标签为 $g_i$ 的所有日志都在 $P_j$ 中）

#### 2.2 PA计算公式

$$
\text{PA} = \frac{1}{n} \sum_{j=1}^{m} |P_j| \cdot \mathbb{1}_{[\exists i: P_j = G_i]}
$$

其中 $\mathbb{1}_{[\cdot]}$ 是指示函数：

$$
\mathbb{1}_{[\exists i: P_j = G_i]} = \begin{cases}
1 & \text{if } \exists i \in \{1,...,k\}: P_j = G_i \\
0 & \text{otherwise}
\end{cases}
$$

简化形式：

$$
\text{PA} = \frac{\text{完美匹配的日志数量}}{n}
$$

---

## 纯度指标

### 3. Prediction Purity (predPure)

预测cluster的纯度，衡量每个预测cluster中主导真实标签的占比。

#### 3.1 单个预测cluster的纯度

对于预测cluster $P_j$：

$$
\text{purity}(P_j) = \frac{\max_{i=1,...,k} |P_j \cap G_i|}{|P_j|}
$$

#### 3.2 加权平均纯度

$$
\text{predPure} = \frac{1}{n} \sum_{j=1}^{m} |P_j| \cdot \text{purity}(P_j)
$$

展开形式：

$$
\text{predPure} = \frac{1}{n} \sum_{j=1}^{m} \max_{i=1,...,k} |P_j \cap G_i|
$$

---

### 4. Ground Truth Purity (gtPure)

真实cluster的纯度，衡量每个真实cluster中主导预测标签的占比。

#### 4.1 单个真实cluster的纯度

对于真实cluster $G_i$：

$$
\text{purity}(G_i) = \frac{\max_{j=1,...,m} |G_i \cap P_j|}{|G_i|}
$$

#### 4.2 加权平均纯度

$$
\text{gtPure} = \frac{1}{n} \sum_{i=1}^{k} |G_i| \cdot \text{purity}(G_i)
$$

展开形式：

$$
\text{gtPure} = \frac{1}{n} \sum_{i=1}^{k} \max_{j=1,...,m} |G_i \cap P_j|
$$

---

## 友好型指标

### 5. Friendly Metrics

友好型指标通过合并纯cluster来减轻过分割的惩罚。

#### 5.1 纯cluster定义

预测cluster $P_j$ 是纯cluster当且仅当：

$$
\exists! i: P_j \subseteq G_i
$$

即存在唯一的真实标签 $g_i$，使得 $P_j$ 中所有日志的真实标签都是 $g_i$。

#### 5.2 Cluster合并映射

定义映射函数 $\phi: P \rightarrow P'$：

$$
\phi(p_j) = \begin{cases}
\text{"__PURE__\#}g_i\text{"} & \text{if } P_j \text{ is pure and } P_j \subseteq G_i \\
p_j & \text{otherwise}
\end{cases}
$$

#### 5.3 合并后的预测标签集合

$$
P' = \{\phi(p_1), \phi(p_2), ..., \phi(p_m)\}
$$

实际效果：将所有属于同一真实cluster的纯预测clusters合并为一个cluster。

#### 5.4 GA_friendly

使用合并后的预测标签 $P'$ 计算GA：

$$
\text{GA\_friendly} = \text{GA}(G, P')
$$

具体计算使用前面定义的GA公式，但将 $P$ 替换为 $P'$。

#### 5.5 PA_friendly

使用合并后的预测标签 $P'$ 计算PA：

$$
\text{PA\_friendly} = \text{PA}(G, P')
$$

#### 5.6 Pure Coverage (pureCoverage)

纯cluster覆盖率，表示被分配到纯cluster的日志比例：

$$
\text{pureCoverage} = \frac{1}{n} \sum_{j=1}^{m} |P_j| \cdot \mathbb{1}_{[P_j \text{ is pure}]}
$$

其中：

$$
\mathbb{1}_{[P_j \text{ is pure}]} = \begin{cases}
1 & \text{if } \exists! i: P_j \subseteq G_i \\
0 & \text{otherwise}
\end{cases}
$$

---

## 指标范围与性质

### 指标范围

所有指标的值域均为 $[0, 1]$：

$$
\text{GA}, \text{PA}, \text{predPure}, \text{gtPure}, \text{pureCoverage} \in [0, 1]
$$

### 完美分组条件

当 $P = G$（预测完全等于真实标签）时：

$$
\begin{align}
\text{GA} &= 1 \\
\text{PA} &= 1 \\
\text{predPure} &= 1 \\
\text{gtPure} &= 1 \\
\text{pureCoverage} &= 1
\end{align}
$$

### 指标关系

#### 过分割情况

如果存在过分割（一个真实cluster被分成多个预测clusters）：

$$
\text{GA\_friendly} \geq \text{GA}
$$

$$
\text{PA\_friendly} \geq \text{PA}
$$

差值越大，过分割越严重。

#### 纯度关系

- **高predPure、低gtPure**：存在过分割（over-segmentation）
- **低predPure、高gtPure**：存在欠分割（under-segmentation）

---

## 边界情况处理

### 零除保护

在实际计算中，需要处理分母为零的情况：

$$
\text{Precision} = \begin{cases}
\frac{A}{T_P} & \text{if } T_P > 0 \\
0 & \text{if } T_P = 0
\end{cases}
$$

$$
\text{Recall} = \begin{cases}
\frac{A}{T_G} & \text{if } T_G > 0 \\
0 & \text{if } T_G = 0
\end{cases}
$$

$$
\text{GA} = \begin{cases}
\frac{2 \times \text{Precision} \times \text{Recall}}{\text{Precision} + \text{Recall}} & \text{if } \text{Precision} + \text{Recall} > 0 \\
0 & \text{otherwise}
\end{cases}
$$

### 空集处理

$$
\binom{n}{2} = \begin{cases}
\frac{n(n-1)}{2} & \text{if } n \geq 2 \\
0 & \text{if } n < 2
\end{cases}
$$

---

## 计算复杂度

| 指标 | 时间复杂度 | 空间复杂度 |
|------|-----------|-----------|
| GA | $O(n + k + m)$ | $O(k + m)$ |
| PA | $O(n + k + m)$ | $O(k + m)$ |
| predPure | $O(n)$ | $O(km)$ |
| gtPure | $O(n)$ | $O(km)$ |
| GA_friendly | $O(n + k + m)$ | $O(k + m)$ |
| pureCoverage | $O(n + m)$ | $O(m)$ |

其中：
- $n$ = 日志总数
- $k$ = 真实cluster数量
- $m$ = 预测cluster数量

---

## 示例计算

### 简单示例

假设有5条日志：

| 日志ID | 真实标签 (G) | 预测标签 (P) |
|--------|-------------|-------------|
| $l_1$ | A | 1 |
| $l_2$ | A | 1 |
| $l_3$ | A | 2 |
| $l_4$ | B | 3 |
| $l_5$ | B | 3 |

#### 计算GA

1. **真实配对数**：
   - $G_A = \{l_1, l_2, l_3\}$，$\binom{3}{2} = 3$
   - $G_B = \{l_4, l_5\}$，$\binom{2}{2} = 1$
   - $T_G = 3 + 1 = 4$

2. **预测配对数**：
   - $P_1 = \{l_1, l_2\}$，$\binom{2}{2} = 1$
   - $P_2 = \{l_3\}$，$\binom{1}{2} = 0$
   - $P_3 = \{l_4, l_5\}$，$\binom{2}{2} = 1$
   - $T_P = 1 + 0 + 1 = 2$

3. **准确配对数**：
   - $P_1$: $|P_1 \cap G_A| = 2$，$\binom{2}{2} = 1$
   - $P_2$: $|P_2 \cap G_A| = 1$，$\binom{1}{2} = 0$
   - $P_3$: $|P_3 \cap G_B| = 2$，$\binom{2}{2} = 1$
   - $A = 1 + 0 + 1 = 2$

4. **GA计算**：
   $$
   \text{Precision} = \frac{2}{2} = 1.0
   $$
   $$
   \text{Recall} = \frac{2}{4} = 0.5
   $$
   $$
   \text{GA} = \frac{2 \times 1.0 \times 0.5}{1.0 + 0.5} = \frac{1.0}{1.5} = 0.667
   $$

#### 计算PA

- $P_1 = \{l_1, l_2\} \neq G_A = \{l_1, l_2, l_3\}$（不完美）
- $P_2 = \{l_3\} \neq G_A$（不完美）
- $P_3 = \{l_4, l_5\} = G_B$（完美匹配）

$$
\text{PA} = \frac{2}{5} = 0.4
$$

#### 计算predPure

- $P_1$: $\max(2, 0) / 2 = 1.0$（纯）
- $P_2$: $\max(1, 0) / 1 = 1.0$（纯）
- $P_3$: $\max(0, 2) / 2 = 1.0$（纯）

$$
\text{predPure} = \frac{2 \times 1.0 + 1 \times 1.0 + 2 \times 1.0}{5} = 1.0
$$

#### 计算GA_friendly

由于 $P_1, P_2$ 都是纯cluster且都属于 $G_A$，合并它们：
- $P'_1 = \text{__PURE__\#A} = \{l_1, l_2, l_3\}$
- $P'_2 = \text{__PURE__\#B} = \{l_4, l_5\}$

使用 $P'$ 重新计算GA：
- $T_{P'} = \binom{3}{2} + \binom{2}{2} = 3 + 1 = 4$
- $A' = 3 + 1 = 4$

$$
\text{GA\_friendly} = \frac{2 \times 4}{4 + 4} = 1.0
$$

#### 计算pureCoverage

所有预测clusters都是纯的：

$$
\text{pureCoverage} = \frac{5}{5} = 1.0
$$

---

## 参考文献格式

建议在论文中引用相关工作：

1. **GA (Grouping Accuracy)**:
   > He, P., Zhu, J., Zheng, Z., & Lyu, M. R. (2017). Drain: An online log parsing approach with fixed depth tree. In *2017 IEEE International Conference on Web Services (ICWS)* (pp. 33-40). IEEE.

2. **Pairwise-based metrics**:
   > Zhu, J., He, S., Liu, J., He, P., Xie, Q., Zheng, Z., & Lyu, M. R. (2019). Tools and benchmarks for automated log parsing. In *2019 IEEE/ACM 41st International Conference on Software Engineering: Software Engineering in Practice (ICSE-SEIP)* (pp. 121-130). IEEE.

3. **LogHub benchmark**:
   > He, S., Zhu, J., He, P., & Lyu, M. R. (2020). Loghub: A large collection of system log datasets towards automated log analytics. *arXiv preprint arXiv:2008.06448*.

---

## 代码实现参考

完整实现见：`baseline/run_and_compare.py`

关键函数：
- `accuracy_metrics()`: 第48-76行
- `purity_metric()`: 第79-92行
- `collapse_pure_clusters()`: 第95-116行
