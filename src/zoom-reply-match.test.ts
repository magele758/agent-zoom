import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionOption } from "./kernel/types.ts";
import {
  exactReplyTokens,
  matchArbitratorDigestAction,
  matchDecisionOption,
  matchTriageDigestAction,
  matchWorkflowAction,
  type ReplyMatchInput,
} from "./server/zoom-http.ts";

const options: DecisionOption[] = [
  { id: "opt_approve", label: "批准上线", outcome: "approved", handlerKey: "test.approve" },
  { id: "opt_reject", label: "拒绝", outcome: "rejected", handlerKey: "test.reject" },
];

test("reply matchers ignore free text and require one exact choice", () => {
  const noisy = {
    matchedOptionId: null,
    matchedChoiceLabel: null,
    matchedChoiceValue: null,
    selectedLabels: null as string[] | null,
    freeText: "先不要执行，改为拒绝",
    otherText: "请 approve 一下",
  };
  const event: ReplyMatchInput = noisy;
  assert.deepEqual(exactReplyTokens(event), []);
  assert.equal(matchDecisionOption(event, options), undefined);
  assert.equal(matchWorkflowAction(event), null);
  assert.equal(matchTriageDigestAction(event), null);
  assert.equal(matchArbitratorDigestAction(event), null);

  assert.equal(matchDecisionOption({ matchedOptionId: "opt_approve" }, options)?.id, "opt_approve");
  assert.equal(matchDecisionOption({ matchedChoiceLabel: "拒绝" }, options)?.id, "opt_reject");
  assert.equal(matchDecisionOption({ selectedLabels: ["批准上线", "拒绝"] }, options), undefined);
  assert.equal(matchDecisionOption({ selectedLabels: ["批准执行"] }, options), undefined);

  assert.equal(matchWorkflowAction({ matchedOptionId: "approve" }), "approve");
  assert.equal(matchWorkflowAction({ selectedLabels: ["批准执行"] }), null);
  assert.equal(matchWorkflowAction({ matchedChoiceLabel: "执行" }), "approve");
  assert.equal(matchWorkflowAction({ selectedLabels: ["批准", "拒绝"] }), null);

  assert.equal(matchTriageDigestAction({ matchedChoiceLabel: "立即审查" }), "run_triage");
  assert.equal(matchTriageDigestAction({ selectedLabels: ["开启自动轮动", "立即审查"] }), null);

  assert.equal(matchArbitratorDigestAction({ matchedChoiceLabel: "立即让 Bot 拍板" }), "run_arbitrator");
  assert.equal(matchArbitratorDigestAction({ matchedOptionId: "delegated_safe" }), "delegated_safe");
});
