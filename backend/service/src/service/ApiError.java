package service;

import java.io.IOException;

import jakarta.servlet.http.HttpServletResponse;
import tools.jackson.databind.ObjectMapper;

public record ApiError(String code, String message) {

    static void write(HttpServletResponse response, ObjectMapper mapper, int status,
            String code, String message) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        mapper.writeValue(response.getOutputStream(), new ApiError(code, message));
    }
}
