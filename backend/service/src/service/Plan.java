package service;

// API 응답 형식이다. price는 KRW 원 단위 정수이며 프론트엔드의 Plan 타입과 맞춘다.
public record Plan(String id, String name, String country, int days, int dataMb,
        SimType simType, long price) {

    public enum SimType {
        ESIM, USIM
    }
}
