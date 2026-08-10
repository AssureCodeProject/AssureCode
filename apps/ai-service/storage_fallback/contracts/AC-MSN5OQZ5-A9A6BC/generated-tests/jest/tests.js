```javascript
// AC-MSN5OQZ5-A9A6BC.test.js

const { describe, it, expect } = require('@jest/globals');

describe('Analytics Dashboard', () => {
  it('should render chart with sample data', async () => {
    const dashboard = new Dashboard();
    const chartData = dashboard.getChartData();
    const chartElement = await dashboard.renderChart(chartData);
    expect(chartElement).toBeTruthy();
  });

  it('should handle empty input data', async () => {
    const dashboard = new Dashboard();
    const chartData = [];
    const chartElement = await dashboard.renderChart(chartData);
    expect(chartElement).toBeNull();
  });

  it('should display error message on failed data export', async () => {
    const dashboard = new Dashboard();
    const chartData = dashboard.getChartData();
    const exportError = await dashboard.exportChartData(chartData);
    expect(exportError).toBe('Failed to export data');
  });

  it('should restrict access to restricted data for non-admin users', async () => {
    const dashboard = new Dashboard();
    const chartData = dashboard.getChartData();
    const restrictedData = await dashboard.getRestrictedData(chartData);
    expect(restrictedData).toBeUndefined();
  });
});
```

```javascript
// Dashboard.test.js

const { describe, it, expect } = require('@jest/globals');

describe('Dashboard', () => {
  it('should have role-based access control', async () => {
    const dashboard = new Dashboard();
    expect(dashboard.hasAccess()).toBe(true);
  });

  it('should handle CSV export', async () => {
    const dashboard = new Dashboard();
    const chartData = dashboard.getChartData();
    const csvExport = await dashboard.exportChartData(chartData);
    expect(csvExport).toBe('Exported data to CSV');
  });

  it('should update chart in real-time', async () => {
    const dashboard = new Dashboard();
    const chartData = dashboard.getChartData();
    const chartElement = await dashboard.renderChart(chartData);
    const updatedChartData = dashboard.getUpdatedChartData();
    await dashboard.updateChart(updatedChartData);
    expect(chartElement.innerHTML).toContain(updatedChartData);
  });
});
```