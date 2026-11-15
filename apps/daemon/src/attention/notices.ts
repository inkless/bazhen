import type { DeviceId } from "@bazhen/core";
import {
  DismissNoticeResponse,
  type DismissNoticeRequest,
  type NoticeAction,
  type NoticeCloser,
} from "@bazhen/protocol";
import type { OpenNotice, Store } from "../store/store.ts";

/**
 * Who asks: the paired device a request came from, or the owner on this machine, by the Unix
 * socket or from a loopback browser where no device must pair, which controls everything already.
 */
export type Viewer = DeviceId | Owner;
type Owner = Exclude<NoticeCloser, "revoke">;

const isOwner = (viewer: Viewer): viewer is Owner =>
  viewer === "owner-socket" || viewer === "owner-loopback";

/** The paired device a viewer is, or undefined for the owner. */
export const deviceOf = (viewer: Viewer): DeviceId | undefined =>
  isOwner(viewer) ? undefined : viewer;

/** A notice that is closed, or never was. */
export class NoticeClosed extends Error {
  readonly noticeId: string;

  constructor(noticeId: string) {
    super(`notice ${noticeId} is not open`);
    this.noticeId = noticeId;
  }
}

/** An action the notice doesn't offer this viewer, such as a paired device dismissing a pairing. */
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
   * Only the owner on this machine dismisses a notice, never from a paired device's browser: one
   * paired with a stolen code would otherwise hide its own pairing, or the real one it then
   * passes for. A paired device can still run commands as the owner, in a shell it opens, so
   * this keeps the notice up; the desktop notification at pairing is what tells the owner.
   */
  actions(_notice: OpenNotice, viewer: Viewer): NoticeAction[] {
    return isOwner(viewer) ? ["dismiss"] : [];
  }

  /**
   * `fromDevice` is advisory: the device whose shell a socket call came from, as that shell's
   * environment claims. It is recorded only for a device this daemon paired.
   */
  dismiss(
    id: string,
    req: DismissNoticeRequest,
    viewer: Viewer,
    fromDevice?: string,
  ): DismissNoticeResponse {
    return this.store.once(
      req.idempotencyKey,
      { notice: id, dismiss: true, by: viewer },
      (r) => DismissNoticeResponse.parse(r),
      () => {
        const open = this.store.openNotices().find((n) => n.id === id);
        if (open === undefined) throw new NoticeClosed(id);
        if (!isOwner(viewer)) throw new NoticeRefused(id, "dismiss");
        const from =
          viewer === "owner-socket" && fromDevice !== undefined && this.store.pairedEver(fromDevice)
            ? { fromDevice }
            : {};
        const eventId = this.store.append({
          type: "notice.closed",
          entityId: open.id,
          actor: "user",
          payload: { reason: "dismissed", by: viewer, ...from },
        });
        return { eventIds: [eventId] };
      },
    );
  }
}
