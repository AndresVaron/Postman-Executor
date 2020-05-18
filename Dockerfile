FROM ubuntu:latest
USER root
RUN apt-get update
RUN apt-get -y install curl gnupg
RUN curl -sL https://deb.nodesource.com/setup_14.x  | bash -
RUN apt-get -y install nodejs
RUN apt-get install docker.io -y 
RUN npm install -g @andresvaron/postman-executor@1.1.6
