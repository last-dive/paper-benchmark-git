'use strict';
// Test-only synthetic response factory; not a model or production fallback.
require('./core.js');
const PB = globalThis.PB;
const TEXT = '第1节：本研究给出了算法完整流程。第2节：我们在三个边界条件下验证误差，并使用相同输入和计算预算进行比较。';
function makeV2Review(paperText = TEXT, options = {}) {
  const quote = options.quote ?? Array.from(paperText.trim()).slice(0, 100).join('');
  if (quote.replace(/\s/gu, '').length < 8) throw Error('测试fixture需要至少8个非空白原文字符');
  const ref = { dimensionId: 'evidence', evidenceIndex: 0 };
  return {
    schemaVersion: 2,
    analysis: {
      researchType: options.researchType || 'theory', typeRationale: '模拟夹具：按给定定义与分析流程检查论证结构。',
      centralClaims: [{ id: 'C1', claim: '模拟夹具：论文报告了可复核的研究流程。', scope: '模拟文本限定范围', evidenceRefs: [{ ...ref }],
        supportAssessment: '模拟夹具引用可见原文，仅验证程序数据流程。', counterEvidence: '模拟材料未提供反证，不据此断言不存在。',
        alternativeExplanations: '模拟材料不提供外部替代解释的排除证据。', verdict: 'partial' }],
      strongestSupport: { text: '模拟夹具最强支撑：给定正文陈述研究流程。', evidenceRefs: [{ ...ref }] },
      strongestChallenge: { text: '模拟夹具最强限制：没有外部真实性核查。', evidenceRefs: [] },
      verificationLimits: '仅用于本地自动测试，不是对任何真实研究的评审。',
    },
    dimensions: PB.DIMS.map(d => ({ id: d.id, evidence: [{ quote, location: '模拟文本第1段' }],
      items: PB.CRITERIA[d.id].map((c, i) => ({ id: c.id, level: options.levels?.[d.id]?.[i] ?? options.level ?? 3,
        status: 'assessable', basis: `模拟夹具：${c.name}的固定等级用于测试本地计算。`, evidenceIndices: [0], missing: '模拟夹具未做研究真实性核查。' })),
      reason: '模拟夹具：使用固定的具体依据检验字段、引文匹配与本地计算流程。',
      improvement: '模拟夹具：请保留可复核的学术表述和明确局限。',
    })),
    revisions: [{ priority: 1, dimensionId: 'rigor', claimIds: ['C1'], action: '模拟夹具：完善现有研究流程的学术报告说明。', rationale: '模拟夹具：便于人工核对证据与中心主张的对应。' }],
    summary: '模拟夹具：只验证程序行为，不代表真实论文质量。', limitations: '模拟结果不提供研究真实性、正确性或性能结论。',
  };
}
module.exports = { makeV2Review, v2Review: makeV2Review, TEXT };
