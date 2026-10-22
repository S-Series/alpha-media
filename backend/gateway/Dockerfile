FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /build/gateway
COPY gateway/pom.xml ./
RUN mvn -B -ntp dependency:go-offline
COPY gateway/src ./src
RUN mvn -B -ntp package -DskipTests

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
COPY --from=build /build/gateway/target/gateway-0.0.1-SNAPSHOT.jar app.jar
USER 10001:10001
EXPOSE 10000
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
