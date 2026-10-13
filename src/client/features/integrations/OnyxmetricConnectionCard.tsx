import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import { Skeleton } from "@/client/components/ui/skeleton";
import { QueryError } from "@/client/components/QueryState";
import { CardShell } from "@/client/components/CardShell";
import { PermissionHint } from "@/client/components/PermissionHint";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { captureClientEvent } from "@/client/lib/posthog";
import {
  disconnectOnyxmetric,
  getOnyxmetricConnection,
  listOnyxmetricSites,
  setOnyxmetricSite,
} from "@/serverFunctions/onyxmetric";

export function onyxmetricConnectionOptions(projectId: string) {
  return {
    queryKey: ["onyxmetricConnection", projectId],
    queryFn: () => getOnyxmetricConnection({ data: { projectId } }),
  };
}

function StatusPill({
  connected,
  configured,
}: {
  connected: boolean;
  configured: boolean;
}) {
  const ready = connected && configured;
  return (
    <Badge variant={ready ? "success" : connected ? "warning" : "outline"}>
      <span className="size-1.5 rounded-full bg-current" />
      {ready ? "Connected" : connected ? "Setup required" : "Not connected"}
    </Badge>
  );
}

/** Lists the sites the server's key can read; saving connects the project. */
function SitePicker({
  projectId,
  onSaved,
  onCancel,
}: {
  projectId: string;
  onSaved: () => void;
  onCancel: (() => void) | null;
}) {
  const [selectedSiteId, setSelectedSiteId] = React.useState<string | null>(
    null,
  );
  const sitesQuery = useQuery({
    queryKey: ["onyxmetricSites", projectId],
    queryFn: () => listOnyxmetricSites({ data: { projectId } }),
    // Always list fresh: sites are added in OnyxMetric outside this app.
    gcTime: 0,
  });
  const saveMutation = useMutation({
    meta: { errorToast: false },
    mutationFn: (siteId: string) =>
      setOnyxmetricSite({ data: { projectId, siteId } }),
    onSuccess: () => {
      captureClientEvent("onyxmetric:site_select");
      toast.success("OnyxMetric connected");
      onSaved();
    },
  });

  const sites = sitesQuery.data?.sites ?? [];
  const unavailable =
    sitesQuery.isError || sitesQuery.data?.available === false;
  const selection =
    selectedSiteId ?? sites.find((site) => site.isSelected)?.siteId ?? null;
  const items = sites.map((site) => ({
    value: site.siteId,
    label: site.domain ? `${site.name} (${site.domain})` : site.name,
  }));

  if (sitesQuery.isLoading)
    return <Skeleton className="h-10 w-full max-w-sm" />;
  return (
    <fieldset disabled={saveMutation.isPending} className="space-y-3">
      {unavailable ? (
        <QueryError
          fallback="Couldn't load sites from OnyxMetric. Check the server's API key."
          onRetry={() => void sitesQuery.refetch()}
          isRetrying={sitesQuery.isFetching}
        />
      ) : sites.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No OnyxMetric sites are available to this server&rsquo;s API key.
        </p>
      ) : (
        <Select
          items={items}
          value={selection}
          onValueChange={(value) => setSelectedSiteId(value)}
        >
          <SelectTrigger className="w-full max-w-sm" aria-label="Site">
            <SelectValue placeholder="Choose a site" />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          disabled={!selection || unavailable}
          pending={saveMutation.isPending}
          onClick={() => selection && saveMutation.mutate(selection)}
        >
          Connect site
        </Button>
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      {saveMutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {getStandardErrorMessage(saveMutation.error)}
        </p>
      ) : null}
    </fieldset>
  );
}

function ConnectedSite({
  projectId,
  siteName,
  siteId,
  canManage,
  onChange,
  onDisconnected,
}: {
  projectId: string;
  siteName: string | null;
  siteId: string | null;
  canManage: boolean;
  onChange: () => void;
  onDisconnected: () => void;
}) {
  const disconnectMutation = useMutation({
    meta: { errorToast: false },
    mutationFn: () => disconnectOnyxmetric({ data: { projectId } }),
    onSuccess: () => {
      toast.success("OnyxMetric disconnected from this project");
      onDisconnected();
    },
  });
  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <p className="break-words text-sm font-semibold">{siteName}</p>
        <p className="mt-1 text-xs text-muted-foreground">Site ID {siteId}</p>
      </div>
      {canManage ? (
        <fieldset
          disabled={disconnectMutation.isPending}
          className="flex flex-wrap items-center gap-1"
        >
          <Button variant="outline" size="sm" onClick={onChange}>
            Change site
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => disconnectMutation.mutate()}
          >
            {disconnectMutation.isPending
              ? "Disconnecting…"
              : "Disconnect project"}
          </Button>
        </fieldset>
      ) : null}
      {disconnectMutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {getStandardErrorMessage(disconnectMutation.error)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Connects one project to an OnyxMetric site. The API key lives in server
 * environment config, so there is no sign-in: pick a site, change it, or
 * disconnect.
 */
export function OnyxmetricConnectionCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [picking, setPicking] = React.useState(false);
  const connectionOptions = onyxmetricConnectionOptions(projectId);
  const connectionQuery = useQuery(connectionOptions);
  const connection = connectionQuery.data;

  const refresh = () => {
    setPicking(false);
    void queryClient.invalidateQueries({
      queryKey: connectionOptions.queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: ["dashboardOnyxmetricReport", projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["dashboardActivation", projectId],
    });
  };

  function renderBody() {
    if (connectionQuery.isPending) {
      return (
        <div
          role="status"
          aria-label="Loading connection"
          className="space-y-3"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9 w-24" />
        </div>
      );
    }
    if (!connection) {
      return (
        <QueryError
          error={connectionQuery.error}
          fallback="Couldn't check this project's connection."
          onRetry={() => void connectionQuery.refetch()}
          isRetrying={connectionQuery.isFetching}
        />
      );
    }
    if (!connection.configured) {
      return (
        <p className="text-sm text-muted-foreground">
          OnyxMetric isn&rsquo;t set up on this server. Set the
          ONYXMETRIC_API_KEY environment variable and restart to connect a site.
        </p>
      );
    }
    if (!connection.canManage && !connection.connected) {
      return (
        <>
          <p className="text-sm text-muted-foreground">
            No OnyxMetric site is connected to this project.
          </p>
          <PermissionHint action="connect OnyxMetric" className="mt-3" />
        </>
      );
    }
    if (!connection.connected || picking) {
      return (
        <SitePicker
          projectId={projectId}
          onSaved={refresh}
          onCancel={connection.connected ? () => setPicking(false) : null}
        />
      );
    }
    return (
      <>
        <ConnectedSite
          projectId={projectId}
          siteName={connection.siteName}
          siteId={connection.siteId}
          canManage={connection.canManage}
          onChange={() => setPicking(true)}
          onDisconnected={refresh}
        />
        {connection.canManage ? null : (
          <PermissionHint
            action="change this project's connection"
            className="mt-3"
          />
        )}
      </>
    );
  }

  return (
    <CardShell
      title="OnyxMetric"
      icon={<BarChart3 className="size-5" aria-hidden />}
      action={
        connection ? (
          <StatusPill
            connected={connection.connected}
            configured={connection.configured}
          />
        ) : undefined
      }
    >
      {renderBody()}
    </CardShell>
  );
}
