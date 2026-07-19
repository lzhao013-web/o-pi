export interface ModelReference {
	provider: string;
	id: string;
}

export function formatModelReference(model: ModelReference | undefined): string | undefined {
	return model === undefined ? undefined : `${model.provider}/${model.id}`;
}
