// AI Spending Analysis modal — just the show/hide toggles. The Generate
// orchestration (generateSpendAnalysis) stays in app.js because it needs
// app-level state (currentYear/Month, transactions, budgets, milesConfig,
// CARDS) to build the overview.

export function openAnalysisModal() {
  document.getElementById('analysisModal').style.display = 'flex';
}

export function closeAnalysisModal() {
  document.getElementById('analysisModal').style.display = 'none';
}
