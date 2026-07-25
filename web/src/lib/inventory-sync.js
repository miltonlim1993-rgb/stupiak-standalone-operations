import { opsClient } from "@/api/opsClient";
import { todayStr } from "@/lib/ops-helpers";

export async function syncInventoryFromStockCount(itemName, actualQty, unit, category) {
  const today = todayStr();
  const existing = await opsClient.entities.InventoryItem.filter({ item_name: itemName }, "-created_date", 1);

  if (existing && existing.length > 0) {
    const invItem = existing[0];
    const threshold = invItem.min_threshold || 0;
    const newStatus = actualQty <= 0 ? "out_of_stock" : actualQty < threshold ? "low" : "in_stock";

    await opsClient.entities.InventoryItem.update(invItem.id, {
      current_qty: actualQty,
      last_counted_date: today,
      status: newStatus,
      unit: unit || invItem.unit,
    });

    if (newStatus !== "in_stock") {
      await opsClient.entities.UrgentIssue.create({
        title: `Low Stock: ${itemName}`,
        description: `${itemName} is ${newStatus === "out_of_stock" ? "OUT OF STOCK" : "below minimum threshold"}. Current: ${actualQty} ${unit || invItem.unit}, Minimum: ${threshold} ${unit || invItem.unit}.`,
        priority: newStatus === "out_of_stock" ? "critical" : "high",
        category: "supplier",
        status: "open",
        assigned_to_role: "supervisor",
      });
    }

    return { ...invItem, current_qty: actualQty, status: newStatus };
  } else {
    const invItem = await opsClient.entities.InventoryItem.create({
      item_name: itemName,
      category: category || "other",
      current_qty: actualQty,
      min_threshold: 0,
      unit: unit || "units",
      last_counted_date: today,
      status: "in_stock",
    });
    return invItem;
  }
}