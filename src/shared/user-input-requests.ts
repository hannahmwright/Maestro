export type UserInputRequestId = string | number;

export interface UserInputQuestionOption {
	label: string;
	description: string;
}

export interface UserInputQuestion {
	id: string;
	header: string;
	question: string;
	options?: UserInputQuestionOption[] | null;
	isOther?: boolean;
	isSecret?: boolean;
}

export interface UserInputRequest {
	requestId: UserInputRequestId;
	threadId: string;
	turnId: string;
	itemId: string;
	questions: UserInputQuestion[];
}

export interface UserInputAnswer {
	answers: string[];
}

export interface UserInputResponse {
	answers: Record<string, UserInputAnswer>;
}
