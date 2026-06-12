import { Modal } from "./Modal";
import { useI18n } from "../i18n";
import { AppIcon } from "./AppIcon";
import "./SshHostTrustModal.css";

type SshHostTrustModalProps = {
  open: boolean;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  trustedFingerprint?: string;
  mode: "first-use" | "changed";
  onCancel: () => void;
  onConfirm: () => void;
};

export function SshHostTrustModal({
  open,
  host,
  port,
  algorithm,
  fingerprint,
  trustedFingerprint,
  mode,
  onCancel,
  onConfirm,
}: SshHostTrustModalProps) {
  const { t } = useI18n();
  const isChanged = mode === "changed";
  const groupedFingerprint = fingerprint.replace(/\s+/g, "").match(/.{1,4}/g)?.join(" ") ?? fingerprint;
  const groupedTrustedFingerprint = trustedFingerprint
    ? trustedFingerprint.replace(/\s+/g, "").match(/.{1,4}/g)?.join(" ") ?? trustedFingerprint
    : "";

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("sshTrust.copy.success"),
              tone: "success",
              toast: true,
              store: false,
            },
          }),
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("app-message", {
            detail: {
              title: t("sshTrust.copy.fail"),
              detail,
              tone: "error",
              toast: true,
              store: false,
            },
          }),
        );
      }
    }
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={isChanged ? t("sshTrust.changed.title") : t("sshTrust.firstUse.title")}
      width={560}
    >
      <div className="ssh-trust-modal">
        <div className={`ssh-trust-modal__alert ${isChanged ? "is-warning" : "is-info"}`}>
          <div className="ssh-trust-modal__alert-icon">
            <AppIcon
              icon={
                isChanged
                  ? "material-symbols:warning-rounded"
                  : "material-symbols:shield-lock-rounded"
              }
              size={18}
            />
          </div>
          <div className="ssh-trust-modal__alert-copy">
            <div className="ssh-trust-modal__alert-title">
              {isChanged ? t("sshTrust.changed.banner") : t("sshTrust.firstUse.banner")}
            </div>
            <p className="settings-section-desc">
              {isChanged
                ? t("sshTrust.changed.desc", { host, port })
                : t("sshTrust.firstUse.desc", { host, port })}
            </p>
          </div>
        </div>

        <div className="ssh-trust-modal__panel">
          <div className="ssh-trust-modal__row">
            <div className="ssh-trust-modal__meta-label">{t("sshTrust.target")}</div>
            <div className="ssh-trust-modal__meta-value">{host}:{port}</div>
          </div>
          <div className="ssh-trust-modal__row">
            <div className="ssh-trust-modal__meta-label">{t("sshTrust.algorithm")}</div>
            <div className="ssh-trust-modal__meta-value">{algorithm}</div>
          </div>
        </div>

        {isChanged && trustedFingerprint ? (
          <div className="ssh-trust-modal__panel">
            <div className="ssh-trust-modal__fingerprint-head">
              <label className="settings-field-label">{t("sshTrust.trusted")}</label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void handleCopy(trustedFingerprint)}
              >
                <AppIcon icon="material-symbols:content-copy-outline-rounded" size={14} />
                {t("sshTrust.copy")}
              </button>
            </div>
            <div className="ssh-trust-modal__fingerprint">{groupedTrustedFingerprint}</div>
          </div>
        ) : null}

        <div className="ssh-trust-modal__panel">
          <div className="ssh-trust-modal__fingerprint-head">
            <label className="settings-field-label">
              {isChanged ? t("sshTrust.presented") : t("sshTrust.fingerprint")}
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void handleCopy(fingerprint)}
            >
              <AppIcon icon="material-symbols:content-copy-outline-rounded" size={14} />
              {t("sshTrust.copy")}
            </button>
          </div>
          <div className="ssh-trust-modal__fingerprint">{groupedFingerprint}</div>
        </div>

        <p className="settings-section-desc">
          {isChanged
            ? t("sshTrust.changed.hint")
            : t("sshTrust.firstUse.hint")}
        </p>
        <div className="connection-detail-actions connection-form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {isChanged ? t("sshTrust.changed.confirm") : t("sshTrust.firstUse.confirm")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
