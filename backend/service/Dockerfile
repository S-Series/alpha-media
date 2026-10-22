FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /build/service
COPY service/pom.xml ./
RUN mvn -B -ntp dependency:go-offline
COPY service/src ./src
# pom.xml의 ../database 경로를 유지해 SQL을 JAR에 포함한다.
COPY database/migration /build/database/migration
RUN mvn -B -ntp package -DskipTests

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
COPY --from=build /build/service/target/service-0.0.1-SNAPSHOT.jar app.jar
USER 10001:10001
EXPOSE 10000
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
