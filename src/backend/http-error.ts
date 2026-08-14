class HttpError extends Error {
    status: number;
    code: string;

    constructor(status: number, message: string, code = 'local_error') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export { HttpError };
