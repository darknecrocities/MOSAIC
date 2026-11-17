interface PlaceholderScreenProps {
  title: string;
  description: string;
  requiresDrive: boolean;
  libraryConnected: boolean;
}

export function PlaceholderScreen({
  title,
  description,
  requiresDrive,
  libraryConnected,
}: PlaceholderScreenProps) {
  return (
    <section className="mosaic-panel" aria-labelledby="screen-title">
      <div className="mosaic-panel-header">
        <h2 id="screen-title">{title}</h2>
        {requiresDrive && !libraryConnected && (
          <span className="mosaic-badge mosaic-badge-warn">External drive required</span>
        )}
      </div>
      <p className="mosaic-subtitle">{description}</p>
    </section>
  );
}
