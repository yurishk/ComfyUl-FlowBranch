export function pairedNodePosition(sourceNode, gap = 40) {
  const x = Number(sourceNode?.pos?.[0]) || 0;
  const y = Number(sourceNode?.pos?.[1]) || 0;
  const width = Number(sourceNode?.size?.[0]) || 0;
  return [x + width + gap, y];
}

function nodeRect(node, fallbackWidth = 250, fallbackHeight = 80) {
  const x = Number(node?.pos?.[0]) || 0;
  const y = Number(node?.pos?.[1]) || 0;
  const width = Number(node?.size?.[0]) || fallbackWidth;
  const height = Number(node?.size?.[1]) || fallbackHeight;
  return { x, y, width, height };
}

function overlaps(left, right, padding) {
  return left.x < right.x + right.width + padding
    && left.x + left.width + padding > right.x
    && left.y < right.y + right.height + padding
    && left.y + left.height + padding > right.y;
}

export function nextAvailablePairedPosition(sourceNode, newNode, nodes = [], gap = 40, padding = 18) {
  const [x, startY] = pairedNodePosition(sourceNode, gap);
  const newSize = nodeRect(newNode);
  let y = startY;

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = { ...newSize, x, y };
    const collision = nodes.find((node) => node !== sourceNode && overlaps(candidate, nodeRect(node), padding));
    if (!collision) return [x, y];
    const occupied = nodeRect(collision);
    y = Math.max(y + newSize.height + padding, occupied.y + occupied.height + padding);
  }
  return [x, y];
}

export function uniquePublisherNode(entries) {
  const nodes = [...new Set((entries || []).map((entry) => entry?.node).filter(Boolean))];
  return nodes.length === 1 ? nodes[0] : null;
}
