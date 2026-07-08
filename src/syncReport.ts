import * as vscode from 'vscode';
import { SyncReport } from './assets';

/**
 * One-line human summary of a sync run, localized. Lives outside assets.ts so
 * the sync engine stays free of the 'vscode' import (it is exercised by
 * headless probes and shares conventions with registry.ts).
 */
export function describeSyncReport(report: SyncReport): string {
  const parts: string[] = [];
  if (report.installed.length) {
    parts.push(vscode.l10n.t('{0} installed', report.installed.length));
  }
  if (report.updated.length) {
    parts.push(vscode.l10n.t('{0} updated', report.updated.length));
  }
  if (report.removed.length) {
    parts.push(vscode.l10n.t('{0} file(s) removed', report.removed.length));
  }
  if (report.customized.length) {
    parts.push(vscode.l10n.t('{0} customized file(s) left untouched', report.customized.length));
  }
  if (report.orphaned.length) {
    parts.push(vscode.l10n.t('{0} asset(s) missing their pack', report.orphaned.length));
  }
  if (report.conflicts.length) {
    parts.push(vscode.l10n.t('{0} install-path conflict(s)', report.conflicts.length));
  }
  return parts.length ? parts.join(', ') : vscode.l10n.t('everything up to date');
}
