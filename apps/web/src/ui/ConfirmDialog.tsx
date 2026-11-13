import { useState } from "react";
import { Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Button } from "./Button.tsx";

/**
 * A button that asks before it acts. The modal traps focus, gives it back to the trigger, and
 * closes on Escape or a tap outside. Its confirm acts once per opening: it stays on screen while
 * the modal animates out, and a second tap there must not send the command again.
 */
export function ConfirmDialog({
  trigger,
  title,
  message,
  confirm,
  onConfirm,
  isDisabled,
}: {
  trigger: string;
  title: string;
  message: string;
  confirm: string;
  onConfirm: () => void;
  isDisabled: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <DialogTrigger onOpenChange={(open) => open && setConfirmed(false)}>
      <Button isDisabled={isDisabled}>{trigger}</Button>
      <ModalOverlay isDismissable className="modal-overlay">
        <Modal className="modal">
          <Dialog className="dialog">
            {({ close }) => (
              <>
                <Heading slot="title" className="dialog-title">
                  {title}
                </Heading>
                <p>{message}</p>
                <div className="dialog-actions">
                  <Button onPress={close}>Cancel</Button>
                  <Button
                    variant="primary"
                    isDisabled={confirmed}
                    onPress={() => {
                      setConfirmed(true);
                      close();
                      onConfirm();
                    }}
                  >
                    {confirm}
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
