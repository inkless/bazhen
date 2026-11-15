import type { DeviceId } from "@bazhen/core";
import {
  DismissNoticeResponse,
  type DismissNoticeRequest,
  type NoticeAction,
} from "@bazhen/protocol";
import type { OpenNotice, Store } from "../store/store.ts";

/**
 * Who asks: the paired device a request came from, or the owner. The owner is the Unix socket,
 * or a browser where no device must pair, which controls everything already.
 */
export type Viewer = DeviceId | "owner";

/** A notice that is closed, or never was. */
export class NoticeClosed extends Error {
  readonly noticeId: string;

  constructor(noticeId: string) {
    super(`notice ${noticeId} is not open`);
    this.noticeId = noticeId;
  }
}

/** An action the notice doesn't offer this viewer, such as a device dismissing its own pairing. */
export class NoticeRefused extends Error {
  readonly noticeId: string;
  readonly action: NoticeAction;

  constructor(noticeId: string, action: NoticeAction) {
    super(`notice ${noticeId} can't be answered with ${action} by this device`);
    this.noticeId = noticeId;
    this.action = action;
  }
}

/** What the human should know that no agent raised, and who may put it away. */
export class Notices {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * The device a notice is about never dismisses it: one paired with a stolen code would
   * otherwise hide its own pairing before the owner looked.
   */
  actions(notice: OpenNotice, viewer: Viewer): NoticeAction[] {
    return notice.deviceId !== null && notice.deviceId === viewer ? [] : ["dismiss"];
  }

  dismiss(id: string, req: DismissNoticeRequest, viewer: Viewer): DismissNoticeResponse {
    return this.store.once(
      req.idempotencyKey,
      { notice: id, dismiss: true },
      (r) => DismissNoticeResponse.parse(r),
      () => {
        const open = this.store.openNotices().find((n) => n.id === id);
        if (open === undefined) throw new NoticeClosed(id);
        if (!this.actions(open, viewer).includes("dismiss")) throw new NoticeRefused(id, "dismiss");
        const eventId = this.store.append({
          type: "notice.closed",
          entityId: open.id,
          actor: "user",
          payload: { reason: "dismissed" },
        });
        return { eventIds: [eventId] };
      },
    );
  }
}
