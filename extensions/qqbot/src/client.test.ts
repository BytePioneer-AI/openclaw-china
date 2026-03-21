import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@xuanyue202/shared";

const mocks = vi.hoisted(() => ({
  httpPost: vi.fn(),
  httpGet: vi.fn(),
}));

vi.mock("@xuanyue202/shared", async () => {
  const actual = await vi.importActual<typeof import("@xuanyue202/shared")>(
    "@xuanyue202/shared"
  );
  return {
    ...actual,
    httpPost: mocks.httpPost,
    httpGet: mocks.httpGet,
  };
});

import {
  MediaFileType,
  clearTokenCache,
  getAccessToken,
  sendC2CInputNotify,
  sendC2CMessage,
  sendChannelMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendGroupMessage,
  uploadC2CMedia,
  uploadGroupMedia,
} from "./client.js";

describe("getAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
  });

  it("coerces numeric appId into string request payload", async () => {
    mocks.httpPost.mockResolvedValue({
      access_token: "token-1",
      expires_in: 7200,
    });

    const token = await getAccessToken(102824485, " secret ");

    expect(token).toBe("token-1");
    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://bots.qq.com/app/getAppAccessToken",
      { appId: "102824485", clientSecret: "secret" },
      { timeout: 15000 }
    );
  });

  it("rejects empty appId values after trimming", async () => {
    await expect(getAccessToken("  ", "secret")).rejects.toThrow("appId");
    expect(mocks.httpPost).not.toHaveBeenCalled();
  });

  it("includes file_name and srv_send_msg for FILE uploads", async () => {
    mocks.httpPost.mockResolvedValue({
      file_uuid: "file-1",
      file_info: "info-1",
      ttl: 3600,
    });

    await uploadC2CMedia({
      accessToken: "token-1",
      openid: "user-1",
      fileType: MediaFileType.FILE,
      fileData: "base64-data",
      fileName: "report.pdf",
    });

    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/v2/users/user-1/files",
      {
        file_type: 4,
        srv_send_msg: false,
        file_data: "base64-data",
        file_name: "report.pdf",
      },
      {
        timeout: 30000,
        headers: {
          Authorization: "QQBot token-1",
        },
      }
    );
  });

  it("sanitizes group file_name and includes srv_send_msg for FILE uploads", async () => {
    mocks.httpPost.mockResolvedValue({
      file_uuid: "file-2",
      file_info: "info-2",
      ttl: 3600,
    });

    await uploadGroupMedia({
      accessToken: "token-2",
      groupOpenid: "GroupABC123XYZ",
      fileType: MediaFileType.FILE,
      fileData: "group-base64-data",
      fileName: 'report<>:"/\\|?*.pdf',
    });

    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/v2/groups/GroupABC123XYZ/files",
      {
        file_type: 4,
        srv_send_msg: false,
        file_data: "group-base64-data",
        file_name: "report_________.pdf",
      },
      {
        timeout: 30000,
        headers: {
          Authorization: "QQBot token-2",
        },
      }
    );
  });

  it("preserves group_openid casing for group message sends", async () => {
    mocks.httpPost.mockResolvedValue({
      id: "msg-1",
      timestamp: 1,
    });

    await sendGroupMessage({
      accessToken: "token-1",
      groupOpenid: "GroupABC123XYZ",
      content: "hello",
      messageId: "msg-raw-1",
      markdown: false,
    });

    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/v2/groups/GroupABC123XYZ/messages",
      expect.objectContaining({
        content: "hello",
        msg_id: "msg-raw-1",
        msg_type: 0,
      }),
      expect.any(Object)
    );
  });

  it("includes passive reply metadata for C2C markdown messages", async () => {
    mocks.httpPost.mockResolvedValue({
      id: "msg-c2c-1",
      timestamp: 1,
      ext_info: {
        ref_idx: "REFIDX-c2c-1",
      },
    });

    const result = await sendC2CMessage({
      accessToken: "token-1",
      openid: "UserABC123XYZ",
      content: "| col1 | col2 |\n| --- | --- |\n| a | b |",
      messageId: "msg-raw-c2c-1",
      markdown: true,
    });

    expect(result).toEqual({
      id: "msg-c2c-1",
      timestamp: 1,
      ext_info: {
        ref_idx: "REFIDX-c2c-1",
      },
    });
    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/v2/users/UserABC123XYZ/messages",
      expect.objectContaining({
        markdown: { content: "| col1 | col2 |\n| --- | --- |\n| a | b |" },
        msg_id: "msg-raw-c2c-1",
        msg_type: 2,
        msg_seq: expect.any(Number),
      }),
      expect.any(Object)
    );
  });

  it("retries passive C2C sends when QQ rejects a duplicate msg_seq", async () => {
    mocks.httpPost
      .mockRejectedValueOnce(
        new HttpError(
          "HTTP 400: Bad Request",
          400,
          JSON.stringify({
            message: "消息被去重，请检查请求msgseq",
            code: 40054005,
            err_code: 40054005,
          })
        )
      )
      .mockResolvedValueOnce({
        id: "msg-c2c-dup-1",
        timestamp: 3,
      });

    const result = await sendC2CMessage({
      accessToken: "token-1",
      openid: "UserABC123XYZ",
      content: "hello after duplicate",
      messageId: "msg-dup-c2c-1",
      markdown: false,
    });

    expect(result).toEqual({ id: "msg-c2c-dup-1", timestamp: 3 });
    expect(mocks.httpPost).toHaveBeenCalledTimes(2);

    const firstBody = mocks.httpPost.mock.calls[0]?.[1] as { msg_seq?: number; msg_id?: string };
    const secondBody = mocks.httpPost.mock.calls[1]?.[1] as { msg_seq?: number; msg_id?: string };

    expect(firstBody.msg_id).toBe("msg-dup-c2c-1");
    expect(secondBody.msg_id).toBe("msg-dup-c2c-1");
    expect(firstBody.msg_seq).toEqual(expect.any(Number));
    expect(secondBody.msg_seq).toEqual(expect.any(Number));
    expect(secondBody.msg_seq).toBeGreaterThan(firstBody.msg_seq ?? 0);
  });

  it("omits passive reply metadata for proactive C2C markdown messages", async () => {
    mocks.httpPost.mockResolvedValue({
      id: "msg-c2c-2",
      timestamp: 2,
      ext_info: {
        ref_idx: "REFIDX-c2c-2",
      },
    });

    const result = await sendProactiveC2CMessage({
      accessToken: "token-1",
      openid: "UserABC123XYZ",
      content: "| col1 | col2 |\n| --- | --- |\n| a | b |",
      markdown: true,
    });

    expect(result).toEqual({
      id: "msg-c2c-2",
      timestamp: 2,
      ext_info: {
        ref_idx: "REFIDX-c2c-2",
      },
    });
    const body = mocks.httpPost.mock.calls[0]?.[1];
    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/v2/users/UserABC123XYZ/messages",
      {
        markdown: { content: "| col1 | col2 |\n| --- | --- |\n| a | b |" },
        msg_type: 2,
      },
      expect.any(Object)
    );
    expect(body).not.toHaveProperty("msg_seq");
    expect(body).not.toHaveProperty("msg_id");
    expect(body).not.toHaveProperty("event_id");
  });

  it("returns refIdx from C2C input notify responses", async () => {
    mocks.httpPost.mockResolvedValue({
      id: "notify-1",
      timestamp: 3,
      ext_info: {
        ref_idx: "REFIDX-notify-1",
      },
    });

    await expect(
      sendC2CInputNotify({
        accessToken: "token-1",
        openid: "UserABC123XYZ",
        messageId: "msg-notify-1",
      })
    ).resolves.toEqual({ refIdx: "REFIDX-notify-1" });
  });

  it("omits passive reply metadata for proactive group markdown messages", async () => {
    mocks.httpPost.mockResolvedValue({
      id: "msg-group-2",
      timestamp: 2,
    });

    await sendProactiveGroupMessage({
      accessToken: "token-2",
      groupOpenid: "GroupABC123XYZ",
      content: "| col1 | col2 |\n| --- | --- |\n| a | b |",
      markdown: true,
    });

    const body = mocks.httpPost.mock.calls[0]?.[1];
    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/v2/groups/GroupABC123XYZ/messages",
      {
        markdown: { content: "| col1 | col2 |\n| --- | --- |\n| a | b |" },
        msg_type: 2,
      },
      expect.any(Object)
    );
    expect(body).not.toHaveProperty("msg_seq");
    expect(body).not.toHaveProperty("msg_id");
    expect(body).not.toHaveProperty("event_id");
  });

  it("preserves channel_id casing for channel message sends", async () => {
    mocks.httpPost.mockResolvedValue({
      id: "msg-2",
      timestamp: 2,
    });

    await sendChannelMessage({
      accessToken: "token-1",
      channelId: "ChannelABC123XYZ",
      content: "hello",
      messageId: "msg-raw-2",
    });

    expect(mocks.httpPost).toHaveBeenCalledWith(
      "https://api.sgroup.qq.com/channels/ChannelABC123XYZ/messages",
      expect.objectContaining({
        content: "hello",
        msg_id: "msg-raw-2",
      }),
      expect.any(Object)
    );
  });

  it("retries passive group sends when QQ rejects a duplicate msg_seq", async () => {
    mocks.httpPost
      .mockRejectedValueOnce(
        new HttpError(
          "HTTP 400: Bad Request",
          400,
          JSON.stringify({
            message: "消息被去重，请检查请求msgseq",
            code: 40054005,
          })
        )
      )
      .mockResolvedValueOnce({
        id: "msg-group-dup-1",
        timestamp: 4,
      });

    const result = await sendGroupMessage({
      accessToken: "token-2",
      groupOpenid: "GroupABC123XYZ",
      content: "hello group duplicate",
      eventId: "evt-dup-group-1",
      markdown: false,
    });

    expect(result).toEqual({ id: "msg-group-dup-1", timestamp: 4 });
    expect(mocks.httpPost).toHaveBeenCalledTimes(2);

    const firstBody = mocks.httpPost.mock.calls[0]?.[1] as { msg_seq?: number; event_id?: string };
    const secondBody = mocks.httpPost.mock.calls[1]?.[1] as { msg_seq?: number; event_id?: string };

    expect(firstBody.event_id).toBe("evt-dup-group-1");
    expect(secondBody.event_id).toBe("evt-dup-group-1");
    expect(secondBody.msg_seq).toBeGreaterThan(firstBody.msg_seq ?? 0);
  });
});
