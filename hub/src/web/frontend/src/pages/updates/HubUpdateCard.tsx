import { Card } from '@/components/Card';
import { Button } from '@/components/FormField';
import { AlertBanner } from '@/components/AlertBanner';

interface HubUpdateCardProps {
  currentVersion: string | undefined;
  latestHub: string | null | undefined;
  hubUpdateAvailable: boolean | undefined;
  hubStatus: 'idle' | 'updating' | 'restarting' | 'done' | 'failed';
  hubError: string;
  startHubUpdate: () => void;
  isAuthenticated: boolean;
}

export function HubUpdateCard({
  currentVersion,
  latestHub,
  hubUpdateAvailable,
  hubStatus,
  hubError,
  startHubUpdate,
  isAuthenticated,
}: HubUpdateCardProps) {
  return (
    <Card title="Hub">
      {!hubUpdateAvailable && (
        <p className="text-sm text-muted">
          Running v{currentVersion || '?'} — no update available.
        </p>
      )}
      {hubUpdateAvailable && !isAuthenticated && (
        <AlertBanner message={`Hub v${latestHub} is available. Log in to update.`} color="yellow" />
      )}
      {isAuthenticated && hubUpdateAvailable && (
        <>
          {hubStatus === 'idle' && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-fg">Update hub to v{latestHub}</span>
              <Button onClick={startHubUpdate}>Update Hub</Button>
            </div>
          )}
          {hubStatus === 'updating' && <AlertBanner message="Sending update command to local agent..." color="yellow" />}
          {hubStatus === 'restarting' && <AlertBanner message="Hub is restarting — this page will reload automatically when it's back..." color="yellow" />}
          {hubStatus === 'done' && <AlertBanner message="Hub updated! Reloading..." color="green" />}
          {hubStatus === 'failed' && <AlertBanner message={hubError || 'Hub update failed.'} color="red" />}
        </>
      )}
    </Card>
  );
}
