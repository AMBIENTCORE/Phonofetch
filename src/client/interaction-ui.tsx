import React, { createContext, useContext, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Toast } from "@base-ui/react/toast";

interface Confirmation {
  title: string;
  description?: string;
  confirmLabel: string;
  onConfirm: () => void;
}

const ConfirmationContext = createContext<((confirmation: Confirmation) => void) | null>(null);
const toastManager = Toast.createToastManager();

export function notifySuccess(message: string): void {
  toastManager.add({ title: message, timeout: 4500, priority: "low" });
}

export function useConfirmation(): (confirmation: Confirmation) => void {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error("Confirmation provider is missing");
  return confirm;
}

function Notifications(): React.ReactElement {
  const { toasts } = Toast.useToastManager();
  return <Toast.Portal><Toast.Viewport className="ui-toast-viewport" aria-label="Notifications">
    {toasts.map(toast => <Toast.Root key={toast.id} toast={toast} className="ui-toast">
      <Toast.Content><Toast.Title>{toast.title}</Toast.Title></Toast.Content>
      <Toast.Close className="quiet" aria-label="Dismiss notification">Close</Toast.Close>
    </Toast.Root>)}
  </Toast.Viewport></Toast.Portal>;
}

export function InteractionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  return <Toast.Provider toastManager={toastManager} limit={1}>
    <ConfirmationContext.Provider value={setConfirmation}>
      {children}
      <Dialog.Root open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="ui-dialog-backdrop" />
          <Dialog.Viewport className="ui-dialog-viewport"><Dialog.Popup className="ui-dialog">
            <Dialog.Title>{confirmation?.title}</Dialog.Title>
            {confirmation?.description && <Dialog.Description>{confirmation.description}</Dialog.Description>}
            <div className="ui-dialog-actions">
              <Dialog.Close className="secondary">Back</Dialog.Close>
              <button type="button" onClick={() => {
                const onConfirm = confirmation?.onConfirm;
                setConfirmation(null);
                onConfirm?.();
              }}>{confirmation?.confirmLabel}</button>
            </div>
          </Dialog.Popup></Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
      <Notifications />
    </ConfirmationContext.Provider>
  </Toast.Provider>;
}

export function CopyButton({ value, label = "Copy path" }: { value: string; label?: string }): React.ReactElement {
  const [error, setError] = useState("");
  return <span className="ui-copy-action"><button type="button" className="quiet" onClick={() => {
    if (!navigator.clipboard?.writeText) {
      toastManager.close("clipboard");
      setError("Clipboard unavailable. Select and copy the text instead.");
      return;
    }
    void navigator.clipboard.writeText(value).then(() => {
      setError("");
      toastManager.add({ id: "clipboard", title: "Copied", timeout: 4500, priority: "low" });
    }).catch(() => {
      toastManager.close("clipboard");
      setError("Could not copy. Select and copy the text instead.");
    });
  }}>{label}</button>{error && <small role="alert" className="warn">{error}</small>}</span>;
}
