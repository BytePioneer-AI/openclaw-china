/**
 * Property-Based Tests for DingTalk Message Parsing
 * 
 * Feature: dingtalk-integration
 * Property 2: 消息解析正确性
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { parseDingtalkMessage, buildInboundContext } from "./bot.js";
import { checkDmPolicy, checkGroupPolicy } from "@xuanyue202/shared";
import type { DingtalkRawMessage, DingtalkMessageContext } from "./types.js";

describe("Feature: dingtalk-integration, Property 2: 消息解析正确性", () => {
  /**
   * Arbitrary for generating valid DingtalkRawMessage objects
   */
  const dingtalkRawMessageArb = fc.record({
    senderId: fc.string({ minLength: 1, maxLength: 50 }),
    senderNick: fc.string({ minLength: 0, maxLength: 50 }),
    conversationType: fc.constantFrom("1", "2") as fc.Arbitrary<"1" | "2">,
    conversationId: fc.string({ minLength: 1, maxLength: 100 }),
    msgtype: fc.constantFrom("text", "audio", "image", "file"),
    text: fc.option(
      fc.record({ content: fc.string({ minLength: 0, maxLength: 500 }) }),
      { nil: undefined }
    ),
    content: fc.option(
      fc.record({
        downloadCode: fc.option(fc.string(), { nil: undefined }),
        duration: fc.option(fc.integer({ min: 0, max: 300 }), { nil: undefined }),
        recognition: fc.option(fc.string({ minLength: 0, maxLength: 500 }), { nil: undefined }),
        fileName: fc.option(fc.string(), { nil: undefined }),
      }),
      { nil: undefined }
    ),
    atUsers: fc.option(
      fc.array(fc.record({ dingtalkId: fc.string({ minLength: 1 }) }), { minLength: 0, maxLength: 5 }),
      { nil: undefined }
    ),
    robotCode: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  }) as fc.Arbitrary<DingtalkRawMessage>;

  /**
   * Property: parseDingtalkMessage should correctly extract senderId, conversationId, 
   * msgtype and content from any valid raw message.
   */
  it("should correctly extract senderId, conversationId, msgtype and content", () => {
    fc.assert(
      fc.property(dingtalkRawMessageArb, (raw) => {
        const ctx = parseDingtalkMessage(raw);
        
        // senderId should be preserved
        expect(ctx.senderId).toBe(raw.senderId);
        
        // conversationId should be preserved
        expect(ctx.conversationId).toBe(raw.conversationId);
        
        // contentType should match msgtype
        expect(ctx.contentType).toBe(raw.msgtype);
        
        // messageId should be generated and contain conversationId
        expect(ctx.messageId).toContain(raw.conversationId);
        
        // senderNick should be preserved
        expect(ctx.senderNick).toBe(raw.senderNick);
        
        // robotCode should be preserved
        expect(ctx.robotCode).toBe(raw.robotCode);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: conversationType "1" should map to "direct", "2" should map to "group"
   */
  it("should correctly map conversationType to chatType", () => {
    fc.assert(
      fc.property(dingtalkRawMessageArb, (raw) => {
        const ctx = parseDingtalkMessage(raw);
        
        if (raw.conversationType === "1") {
          expect(ctx.chatType).toBe("direct");
        } else if (raw.conversationType === "2") {
          expect(ctx.chatType).toBe("group");
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Text messages should extract text.content
   */
  it("should extract text.content for text messages", () => {
    const textMessageArb = fc.record({
      senderId: fc.string({ minLength: 1, maxLength: 50 }),
      senderNick: fc.string({ minLength: 0, maxLength: 50 }),
      conversationType: fc.constantFrom("1", "2") as fc.Arbitrary<"1" | "2">,
      conversationId: fc.string({ minLength: 1, maxLength: 100 }),
      msgtype: fc.constant("text"),
      text: fc.record({ content: fc.string({ minLength: 0, maxLength: 500 }) }),
      atUsers: fc.option(
        fc.array(fc.record({ dingtalkId: fc.string({ minLength: 1 }) })),
        { nil: undefined }
      ),
      robotCode: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    }) as fc.Arbitrary<DingtalkRawMessage>;

    fc.assert(
      fc.property(textMessageArb, (raw) => {
        const ctx = parseDingtalkMessage(raw);
        
        // Content should be the trimmed text.content
        expect(ctx.content).toBe(raw.text!.content.trim());
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Audio messages should extract content.recognition
   */
  it("should extract content.recognition for audio messages", () => {
    const audioMessageArb = fc.record({
      senderId: fc.string({ minLength: 1, maxLength: 50 }),
      senderNick: fc.string({ minLength: 0, maxLength: 50 }),
      conversationType: fc.constantFrom("1", "2") as fc.Arbitrary<"1" | "2">,
      conversationId: fc.string({ minLength: 1, maxLength: 100 }),
      msgtype: fc.constant("audio"),
      content: fc.record({
        recognition: fc.string({ minLength: 0, maxLength: 500 }),
        duration: fc.option(fc.integer({ min: 0, max: 300 }), { nil: undefined }),
      }),
      atUsers: fc.option(
        fc.array(fc.record({ dingtalkId: fc.string({ minLength: 1 }) })),
        { nil: undefined }
      ),
      robotCode: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    }) as fc.Arbitrary<DingtalkRawMessage>;

    fc.assert(
      fc.property(audioMessageArb, (raw) => {
        const ctx = parseDingtalkMessage(raw);
        
        // Content should be the trimmed recognition text
        expect(ctx.content).toBe(raw.content!.recognition!.trim());
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: mentionedBot should be true when atUsers array is non-empty,
   * false when empty or undefined.
   */
  it("should correctly detect @mentions with or without robotCode", () => {
    fc.assert(
      fc.property(dingtalkRawMessageArb, (raw) => {
        const ctx = parseDingtalkMessage(raw);

        const atUsers = raw.atUsers ?? [];
        const hasAtUsers = atUsers.length > 0;

        // The implementation simply checks if atUsers array is non-empty
        expect(ctx.mentionedBot).toBe(hasAtUsers);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Messages without text or recognition should have empty content
   */
  it("should return empty content for unsupported message types", () => {
    const unsupportedMessageArb = fc.record({
      senderId: fc.string({ minLength: 1, maxLength: 50 }),
      senderNick: fc.string({ minLength: 0, maxLength: 50 }),
      conversationType: fc.constantFrom("1", "2") as fc.Arbitrary<"1" | "2">,
      conversationId: fc.string({ minLength: 1, maxLength: 100 }),
      msgtype: fc.constantFrom("image", "file", "video"),
      // No text or content.recognition
      atUsers: fc.option(
        fc.array(fc.record({ dingtalkId: fc.string({ minLength: 1 }) })),
        { nil: undefined }
      ),
      robotCode: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    }) as fc.Arbitrary<DingtalkRawMessage>;

    fc.assert(
      fc.property(unsupportedMessageArb, (raw) => {
        const ctx = parseDingtalkMessage(raw);
        
        // Content should be empty for unsupported types
        expect(ctx.content).toBe("");
      }),
      { numRuns: 100 }
    );
  });
});


describe("Feature: dingtalk-integration, Property 3: 策略检查正确性", () => {
  /**
   * Property: When dmPolicy is "allowlist", only senders in allowFrom should be allowed
   * Validates: Requirement 5.1
   */
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
        
        if (!isInAllowlist) {
          expect(result.reason).toContain("not in DM allowlist");
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: When dmPolicy is "open" or "pairing", all senders should be allowed
   */
  it("should allow all senders when dmPolicy is open or pairing", () => {
    const testArb = fc.record({
      dmPolicy: fc.constantFrom("open", "pairing") as fc.Arbitrary<"open" | "pairing">,
      senderId: fc.string({ minLength: 1, maxLength: 50 }),
      allowFrom: fc.array(fc.string({ minLength: 1, maxLength: 50 })),
    });

    fc.assert(
      fc.property(testArb, ({ dmPolicy, senderId, allowFrom }) => {
        const result = checkDmPolicy({
          dmPolicy,
          senderId,
          allowFrom,
        });

        // Should always be allowed for open and pairing policies
        expect(result.allowed).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: When groupPolicy is "disabled", all group messages should be rejected
   * Validates: Requirement 5.2
   */
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

        // Should always be rejected for disabled policy
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("group messages disabled");
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: When groupPolicy is "allowlist", only groups in groupAllowFrom should be allowed
   * Validates: Requirement 5.3
   */
  it("should only allow groups in groupAllowFrom when groupPolicy is allowlist", () => {
    const testArb = fc.record({
      conversationId: fc.string({ minLength: 1, maxLength: 100 }),
      groupAllowFrom: fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 0, maxLength: 10 }),
      mentionedBot: fc.constant(true), // Always mentioned to isolate allowlist check
    });

    fc.assert(
      fc.property(testArb, ({ conversationId, groupAllowFrom, mentionedBot }) => {
        const result = checkGroupPolicy({
          groupPolicy: "allowlist",
          conversationId,
          groupAllowFrom,
          requireMention: true,
          mentionedBot,
        });

        const isInAllowlist = groupAllowFrom.includes(conversationId);
        expect(result.allowed).toBe(isInAllowlist);
        
        if (!isInAllowlist) {
          expect(result.reason).toContain("not in allowlist");
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: When requireMention is true, only messages with mentionedBot=true should be allowed
   * Validates: Requirement 5.4
   */
  it("should only allow messages that mention bot when requireMention is true", () => {
    const testArb = fc.record({
      conversationId: fc.string({ minLength: 1, maxLength: 100 }),
      mentionedBot: fc.boolean(),
    });

    fc.assert(
      fc.property(testArb, ({ conversationId, mentionedBot }) => {
        const result = checkGroupPolicy({
          groupPolicy: "open", // Use open to isolate mention check
          conversationId,
          groupAllowFrom: [],
          requireMention: true,
          mentionedBot,
        });

        expect(result.allowed).toBe(mentionedBot);
        
        if (!mentionedBot) {
          expect(result.reason).toContain("did not mention bot");
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: When requireMention is false, messages should be allowed regardless of mention status
   */
  it("should allow messages regardless of mention when requireMention is false", () => {
    const testArb = fc.record({
      conversationId: fc.string({ minLength: 1, maxLength: 100 }),
      mentionedBot: fc.boolean(),
    });

    fc.assert(
      fc.property(testArb, ({ conversationId, mentionedBot }) => {
        const result = checkGroupPolicy({
          groupPolicy: "open",
          conversationId,
          groupAllowFrom: [],
          requireMention: false,
          mentionedBot,
        });

        // Should always be allowed when requireMention is false
        expect(result.allowed).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: When groupPolicy is "open" and requireMention is false, all group messages should be allowed
   */
  it("should allow all group messages when groupPolicy is open and requireMention is false", () => {
    const testArb = fc.record({
      conversationId: fc.string({ minLength: 1, maxLength: 100 }),
      groupAllowFrom: fc.array(fc.string({ minLength: 1, maxLength: 100 })),
      mentionedBot: fc.boolean(),
    });

    fc.assert(
      fc.property(testArb, ({ conversationId, groupAllowFrom, mentionedBot }) => {
        const result = checkGroupPolicy({
          groupPolicy: "open",
          conversationId,
          groupAllowFrom,
          requireMention: false,
          mentionedBot,
        });

        // Should always be allowed
        expect(result.allowed).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});


describe("Feature: dingtalk-integration, Property 4: 上下文构建完整性", () => {
  /**
   * Arbitrary for generating valid DingtalkMessageContext objects
   */
  const messageContextArb: fc.Arbitrary<DingtalkMessageContext> = fc.record({
    conversationId: fc.string({ minLength: 1, maxLength: 100 }),
    messageId: fc.string({ minLength: 1, maxLength: 100 }),
    senderId: fc.string({ minLength: 1, maxLength: 50 }),
    senderNick: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: undefined }),
    chatType: fc.constantFrom("direct", "group") as fc.Arbitrary<"direct" | "group">,
    content: fc.string({ minLength: 0, maxLength: 500 }),
    contentType: fc.constantFrom("text", "audio", "image", "file"),
    mentionedBot: fc.boolean(),
    robotCode: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  });

  /**
   * Property: buildInboundContext should include all required fields
   * Validates: Requirement 6.4
   */
  it("should include all required fields in inbound context", () => {
    const testArb = fc.tuple(
      messageContextArb,
      fc.string({ minLength: 1, maxLength: 50 }), // sessionKey
      fc.string({ minLength: 1, maxLength: 50 }), // accountId
    );

    fc.assert(
      fc.property(testArb, ([ctx, sessionKey, accountId]) => {
        const inboundCtx = buildInboundContext(ctx, sessionKey, accountId);

        // All required fields must be present
        expect(inboundCtx.Body).toBeDefined();
        expect(inboundCtx.From).toBeDefined();
        expect(inboundCtx.To).toBeDefined();
        expect(inboundCtx.SessionKey).toBe(sessionKey);
        expect(inboundCtx.ChatType).toBe(ctx.chatType);
        expect(inboundCtx.SenderId).toBe(ctx.senderId);
        expect(inboundCtx.Provider).toBe("dingtalk");
        expect(inboundCtx.MessageSid).toBe(ctx.messageId);
        expect(inboundCtx.AccountId).toBe(accountId);
        expect(inboundCtx.Timestamp).toBeGreaterThan(0);
        expect(inboundCtx.WasMentioned).toBe(ctx.mentionedBot);
        expect(inboundCtx.CommandAuthorized).toBe(true);
        expect(inboundCtx.OriginatingChannel).toBe("dingtalk");
        expect(inboundCtx.OriginatingTo).toBeDefined();
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Body should contain the message content
   */
  it("should set Body to message content", () => {
    const testArb = fc.tuple(
      messageContextArb,
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 1, maxLength: 50 }),
    );

    fc.assert(
      fc.property(testArb, ([ctx, sessionKey, accountId]) => {
        const inboundCtx = buildInboundContext(ctx, sessionKey, accountId);

        expect(inboundCtx.Body).toBe(ctx.content);
        expect(inboundCtx.RawBody).toBe(ctx.content);
        expect(inboundCtx.CommandBody).toBe(ctx.content);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: From should be formatted correctly based on chat type
   */
  it("should format From correctly based on chat type", () => {
    const testArb = fc.tuple(
      messageContextArb,
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 1, maxLength: 50 }),
    );

    fc.assert(
      fc.property(testArb, ([ctx, sessionKey, accountId]) => {
        const inboundCtx = buildInboundContext(ctx, sessionKey, accountId);

        if (ctx.chatType === "group") {
          expect(inboundCtx.From).toBe(`dingtalk:group:${ctx.conversationId}`);
        } else {
          expect(inboundCtx.From).toBe(`dingtalk:${ctx.senderId}`);
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: To should be formatted correctly based on chat type
   */
  it("should format To correctly based on chat type", () => {
    const testArb = fc.tuple(
      messageContextArb,
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 1, maxLength: 50 }),
    );

    fc.assert(
      fc.property(testArb, ([ctx, sessionKey, accountId]) => {
        const inboundCtx = buildInboundContext(ctx, sessionKey, accountId);

        if (ctx.chatType === "group") {
          expect(inboundCtx.To).toBe(`chat:${ctx.conversationId}`);
          expect(inboundCtx.GroupSubject).toBe(ctx.conversationId);
        } else {
          expect(inboundCtx.To).toBe(`user:${ctx.senderId}`);
          expect(inboundCtx.GroupSubject).toBeUndefined();
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property: SenderName should be set from senderNick
   */
  it("should set SenderName from senderNick", () => {
    const testArb = fc.tuple(
      messageContextArb,
      fc.string({ minLength: 1, maxLength: 50 }),
      fc.string({ minLength: 1, maxLength: 50 }),
    );

    fc.assert(
      fc.property(testArb, ([ctx, sessionKey, accountId]) => {
        const inboundCtx = buildInboundContext(ctx, sessionKey, accountId);

        expect(inboundCtx.SenderName).toBe(ctx.senderNick);
      }),
      { numRuns: 100 }
    );
  });
});
