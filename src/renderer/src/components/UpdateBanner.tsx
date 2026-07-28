export function UpdateBanner({
  version,
  onUpdate,
  onDismiss
}: {
  version: string
  onUpdate: () => void
  onDismiss: () => void
}): JSX.Element {
  return (
    <div className="update-banner" role="status">
      <div className="update-banner-body">
        <div className="update-banner-title">
          <span className="update-dot" />
          Update ready — v{version}
        </div>
        <div className="update-banner-text">
          A new version is downloaded and ready to install.
        </div>
      </div>
      <div className="update-banner-actions">
        <button className="ghost-btn" onClick={onDismiss}>
          Dismiss
        </button>
        <button className="run-btn" onClick={onUpdate}>
          Update
        </button>
      </div>
    </div>
  )
}
