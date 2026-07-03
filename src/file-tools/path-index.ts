/** 路径 trie 节点；descendantFileCount 用于折叠节点准确计数。 */
export interface PathIndexNode {
	name: string;
	path: string;
	children: Map<string, PathIndexNode>;
	isFile: boolean;
	descendantFileCount: number;
}

/** 路径 trie 只保存文件路径结构，用于 find 在预算内压缩公共目录前缀。 */
export function createPathIndex(paths: string[]): PathIndexNode {
	const root: PathIndexNode = {
		name: "",
		path: ".",
		children: new Map(),
		isFile: false,
		descendantFileCount: 0,
	};
	for (const filePath of paths) addPath(root, filePath);
	return root;
}

/** 子节点排序固定为大小写折叠后的字典序，保证 find 输出稳定。 */
export function sortedChildren(node: PathIndexNode): PathIndexNode[] {
	return Array.from(node.children.values()).sort(compareNodeName);
}

function addPath(root: PathIndexNode, filePath: string): void {
	const parts = filePath.split("/").filter((part) => part.length > 0);
	let node = root;
	node.descendantFileCount += 1;
	for (const part of parts) {
		let child = node.children.get(part);
		if (child === undefined) {
			child = {
				name: part,
				path: node.path === "." ? part : `${node.path}/${part}`,
				children: new Map(),
				isFile: false,
				descendantFileCount: 0,
			};
			node.children.set(part, child);
		}
		child.descendantFileCount += 1;
		node = child;
	}
	node.isFile = true;
}

function compareNodeName(left: PathIndexNode, right: PathIndexNode): number {
	const folded = compareStableString(left.name.toLowerCase(), right.name.toLowerCase());
	if (folded !== 0) return folded;
	return compareStableString(left.name, right.name);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
