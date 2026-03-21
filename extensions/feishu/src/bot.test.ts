/**
 * Property-Based Tests for Feishu Message Parsing
 *
 * Feature: feishu-integration
 * Property 2: 消息解析正确性
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { parseFeishuMessageEvent, buildInboundContext } from "./bot.js";
import { checkDmPolicy, checkGroupPolicy } from "@xuanyue202/shared";
import type { FeishuMessageEvent, FeishuMessageContext } from "./types.js";

describe("Feature: feishu-integration, Property 2: 消息解析正确性", () => {
  const feishuEventArb: fc.Arbitrary<FeishuMessageEvent> = fc.record({
    sender: fc.option(
      fc.record({
        sender_id: fc.option(
          fc.record({
            open_id: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
            user_id: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
            union_id: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
          }),
          { nil: undefined }
        ),
      }),
      { nil: undefined }
    ),
    message: fc.option(
      fc.record({
        message_id: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
        chat_id: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
        chat_type: fc.option(fc.constantFrom("p2p", "group"), { nil: undefined }),
        message_type: fc.option(fc.constantFrom("text", "image", "file"), { nil: undefined }),
        content: fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: undefined }),
        create_time: fc.option(fc.string({ minLength: 0, maxLength: 20 }), { nil: undefined }),
        mentions: fc.option(
          fc.array(
            fc.record({
              key: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
              id: fc.option(
                fc.record({
                  open_id: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
                }),
                { nil: undefined }
              ),
              name: fc.option(fc.string({ minLength: 0, maxLength: 20 }), { nil: undefined }),
            })
          ),
          { nil: undefined }
        ),
      }),
      { nil: undefined }
    ),
  });

  it("should map chat_type to chatType", () => {
    fc.assert(
      fc.property(feishuEventArb, (event) => {
        const ctx = parseFeishuMessageEvent(event);
        if (event.message?.chat_type === "group") {
          expect(ctx.chatType).toBe("group");
        } else {
          expect(ctx.chatType).toBe("direct");
        }
      }),
      { numRuns: 100 }
    );
  });

  it("should extract text content from JSON when message_type is text", () => {
    const eventArb = fc.record({
      sender: fc.record({ sender_id: fc.record({ open_id: fc.string({ minLength: 1 }) }) }),
      message: fc.record({
        message_id: fc.string({ minLength: 1 }),
        chat_id: fc.string({ minLength: 1 }),
        chat_type: fc.constantFrom("p2p", "group"),
        message_type: fc.constant("text"),
        content: fc.string({ minLength: 0, maxLength: 50 }).map((text) => JSON.stringify({ text })),
      }),
    }) as fc.Arbitrary<FeishuMessageEvent>;

    fc.assert(
      fc.property(eventArb, (event) => {
        const ctx = parseFeishuMessageEvent(event);
        const parsed = JSON.parse(event.message!.content ?? "{}") as { text?: string };
        expect(ctx.content).toBe((parsed.text ?? "").trim());
      }),
      { numRuns: 100 }
    );
  });

  it("should set mentionedBot when mentions exist", () => {
    const eventArb = fc.record({
      sender: fc.record({ sender_id: fc.record({ open_id: fc.string({ minLength: 1 }) }) }),
      message: fc.record({
        message_id: fc.string({ minLength: 1 }),
        chat_id: fc.string({ minLength: 1 }),
        chat_type: fc.constantFrom("p2p", "group"),
        message_type: fc.constant("text"),
        content: fc.constant(JSON.stringify({ text: "hi" })),
        mentions: fc.array(fc.record({ key: fc.string({ minLength: 1 }) }), { minLength: 1 }),
      }),
    }) as fc.Arbitrary<FeishuMessageEvent>;

    fc.assert(
      fc.property(eventArb, (event) => {
        const ctx = parseFeishuMessageEvent(event);
        expect(ctx.mentionedBot).toBe(true);
      }),
      { numRuns: 50 }
    );
  });
});


describe("Feature: feishu-integration, Property 3: 策略检查正确性", () => {
  it("should only allow senders in allowFrom when dmPolicy is allowlist", () => {
    const testArb = fc.record({
      senderId: fc.string({ minLength: 1, maxLength: 50 }),
      allowFrom: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 10 }),
    });

    fc.assert(
      fc.property(testArb, ({ senderId, allowFrom }) => {
        const result = checkDmPolicy({
          dmPolicy: "allowlist",
          senderId,
          allowFrom,
        });

        const isInAllowlist = allowFrom.includes(senderId);
        expect(result.allowed).toBe(isInAllowlist);
      }),
      { numRuns: 100 }
    );
  });

  it("should reject all group messages when groupPolicy is disabled", () => {
    const testArb = fc.record({
      conversationId: fc.string({ minLength: 1, maxLength: 100 }),
      groupAllowFrom: fc.array(fc.string({ minLength: 1, maxLength: 100 })),
      requireMention: fc.boolean(),
      mentionedBot: fc.boolean(),
    });

    fc.assert(
      fc.property(testArb, ({ conversationId, groupAllowFrom, requireMention, mentionedBot }) => {
        const result = checkGroupPolicy({
          groupPolicy: "disabled",
          conversationId,
          groupAllowFrom,
          requireMention,
          mentionedBot,
        });

        expect(result.allowed).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});


describe("Feature: feishu-integration, Property 4: 上下文构建完整性", () => {
  const messageContextArb: fc.Arbitrary<FeishuMessageContext> = fc.record({
    chatId: fc.string({ minLength: 1, maxLength: 100 }),
    messageId: fc.string({ minLength: 1, maxLength: 100 }),
    senderId: fc.string({ minLength: 1, maxLength: 50 }),
    chatType: fc.constantFrom("direct", "group") as fc.Arbitrary<"direct" | "group">,
    content: fc.string({ minLength: 0, maxLength: 500 }),
    contentType: fc.constantFrom("text", "image", "file"),
    mentionedBot: fc.boolean(),
  });

  it("should include all required fields in inbound context", () => {
    const testArb = fc.tuple(
      messageContextArb,
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 1, maxLength: 50 })
    );

    fc.assert(
      fc.property(testArb, ([ctx, sessionKey, accountId]) => {
        const inboundCtx = buildInboundContext(ctx, sessionKey, accountId);
        expect(inboundCtx.Body).toBeDefined();
        expect(inboundCtx.From).toBeDefined();
        expect(inboundCtx.To).toBeDefined();
        expect(inboundCtx.SessionKey).toBe(sessionKey);
        expect(inboundCtx.ChatType).toBe(ctx.chatType);
        expect(inboundCtx.SenderId).toBe(ctx.senderId);
        expect(inboundCtx.Provider).toBe("feishu");
        expect(inboundCtx.MessageSid).toBe(ctx.messageId);
        expect(inboundCtx.AccountId).toBe(accountId);
        expect(inboundCtx.Timestamp).toBeGreaterThan(0);
        expect(inboundCtx.WasMentioned).toBe(ctx.mentionedBot);
        expect(inboundCtx.CommandAuthorized).toBe(true);
        expect(inboundCtx.OriginatingChannel).toBe("feishu-china");
        expect(inboundCtx.OriginatingTo).toBeDefined();
      }),
      { numRuns: 100 }
    );
  });

  it("should format From correctly based on chat type", () => {
    const testArb = fc.tuple(
      messageContextArb,
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 1, maxLength: 50 })
    );

    fc.assert(
      fc.property(testArb, ([ctx, sessionKey, accountId]) => {
        const inboundCtx = buildInboundContext(ctx, sessionKey, accountId);
        if (ctx.chatType === "group") {
          expect(inboundCtx.From).toBe(`feishu:group:${ctx.chatId}`);
        } else {
          expect(inboundCtx.From).toBe(`feishu:${ctx.senderId}`);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("should format To correctly based on chat type", () => {
    const testArb = fc.tuple(
      messageContextArb,
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 1, maxLength: 50 })
    );

    fc.assert(
      fc.property(testArb, ([ctx, sessionKey, accountId]) => {
        const inboundCtx = buildInboundContext(ctx, sessionKey, accountId);
        if (ctx.chatType === "group") {
          expect(inboundCtx.To).toBe(`chat:${ctx.chatId}`);
          expect(inboundCtx.GroupSubject).toBe(ctx.chatId);
        } else {
          expect(inboundCtx.To).toBe(`user:${ctx.senderId}`);
          expect(inboundCtx.GroupSubject).toBeUndefined();
        }
      }),
      { numRuns: 100 }
    );
  });
});
